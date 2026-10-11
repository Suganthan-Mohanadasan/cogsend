import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, E2E_D1_FLAGS, waitForLiveComposer } from './e2e-env';

/**
 * A post that is already scheduled, opened in the composer: it says where and
 * when it goes out, and every action (schedule, publish, delete, unschedule,
 * account changes) is worded for that and does what it says. Schedule and
 * publish are answered here so no provider is contacted; the draft read and
 * the bulk cancel are the real routes, which never contact one either.
 */

function d1(sql: string) {
	execSync(`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "${sql}"`, {
		stdio: 'pipe'
	});
}

const PREFIX = 'scheduled-post';
const connIds: string[] = [];

/** Leaves the shared e2e database as the other specs expect it: no extra
 *  accounts (smoke checks an empty Accounts page) and no extra posts. */
test.afterEach(() => {
	const ids = connIds.splice(0);
	const drafts = `SELECT id FROM drafts WHERE base_body LIKE '${PREFIX}%'`;
	d1(
		`DELETE FROM publish_targets WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM draft_variants WHERE draft_id IN (${drafts}); ` +
			`DELETE FROM drafts WHERE base_body LIKE '${PREFIX}%'` +
			(ids.length
				? `; DELETE FROM connections WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`
				: '')
	);
});

type Row = {
	status: 'scheduled' | 'published' | 'failed';
	jobId?: string;
	error?: string;
};

/**
 * A post with one target per row, each on its own seeded (never contacted)
 * Bluesky account, all ticked. Returns the accounts with the short name the
 * composer shows for them.
 */
async function seedPost(page: Page, rows: Row[]) {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const draftId = randomUUID();
	const body = `${PREFIX} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	const inTwoHours = now + 2 * 60 * 60 * 1000;
	const accounts = rows.map(() => {
		const id = randomUUID();
		connIds.push(id);
		return { id, short: `sp-${id.slice(0, 8)}` };
	});
	// d1() wraps the SQL in double quotes for the shell, so the JSON's own are escaped.
	const selection = JSON.stringify(accounts.map((a) => a.id)).replace(/"/g, '\\"');
	const sql = [
		...accounts.map(
			(a) =>
				`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${a.id}', '${userId}', 'bluesky', '${a.short}.bsky.social', 'enc', '{}', 'active', ${now}, ${now})`
		),
		`INSERT INTO drafts (id, user_id, title, base_body, selected_connection_ids, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${selection}', 'scheduled', ${now}, ${now})`,
		...rows.map((row, i) => {
			const when = row.status === 'scheduled' ? String(inTwoHours) : 'NULL';
			const remote = row.status === 'published' ? `'remote-${i}'` : 'NULL';
			const error = row.error ? `'${row.error}'` : 'NULL';
			const job = row.jobId ? `'${row.jobId}'` : 'NULL';
			return `INSERT INTO publish_targets (id, draft_id, connection_id, status, scheduled_for, remote_post_id, error_message, job_id, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${accounts[i].id}', '${row.status}', ${when}, ${remote}, ${error}, ${job}, 0, ${now}, ${now})`;
		})
	];
	d1(sql.join('; '));
	return { draftId, body, accounts };
}

async function openPost(page: Page, draftId: string, body: string) {
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await waitForLiveComposer(page);
}

async function targetStatuses(page: Page, draftId: string) {
	const res = await page.request.get(`/api/drafts/${draftId}`);
	const { draft } = await res.json();
	return {
		draft: draft.status as string,
		targets: Object.fromEntries(
			(draft.targets as Array<{ connectionId: string; status: string }>).map((t) => [
				t.connectionId,
				t.status
			])
		) as Record<string, string>
	};
}

async function untick(page: Page, short: string) {
	const row = page.locator(`button[title="Bluesky: ${short}.bsky.social"]`);
	await clickUntilVisible(page, page.getByTestId('destinations-toggle'), row);
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'false');
	await page.keyboard.press('Escape');
}

test('a scheduled post says when it goes out and words its actions for that', async ({ page }) => {
	const { draftId, body, accounts } = await seedPost(page, [
		{ status: 'scheduled' },
		{ status: 'scheduled' }
	]);
	await openPost(page, draftId, body);

	const status = page.getByTestId('post-status-scheduled');
	await expect(status).toContainText('Scheduled for');
	await expect(status).toContainText(accounts[0].short);
	await expect(status).toContainText(accounts[1].short);
	await expect(page.getByTestId('publish-now')).toContainText('Publish now');

	await page.getByTestId('post-status-change-time').click();
	const panel = page.getByTestId('schedule-panel');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Reschedule');
	await expect(page.getByTestId('schedule-confirm')).toHaveText('Update schedule');
	// Opened on the stored time, not the one-hour default.
	await expect(page.getByTestId('schedule-offsets')).toBeHidden();
	await page.keyboard.press('Escape');

	await expect(panel).toBeHidden();

	await page.getByRole('button', { name: 'Delete scheduled post' }).click();
	const confirm = page.getByRole('alertdialog', { name: 'Delete this scheduled post?' });
	await expect(confirm).toContainText("It won't be published");
	await expect(confirm.getByTestId('confirm-dialog-ok')).toHaveText('Delete');
	await confirm.getByTestId('confirm-dialog-cancel').click();
	await expect(confirm).toHaveCount(0);
});

test('unticking an account asks for the schedule to be updated, then applies it', async ({
	page
}) => {
	const { draftId, body, accounts } = await seedPost(page, [
		{ status: 'scheduled' },
		{ status: 'scheduled' }
	]);
	const sent: Array<Record<string, unknown>> = [];
	await page.route(`**/api/drafts/${draftId}/schedule`, async (route) => {
		const request = route.request().postDataJSON();
		sent.push(request);
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ targets: [], scheduledFor: request.runAt, cancelled: [] })
		});
	});
	await openPost(page, draftId, body);
	await expect(page.getByTestId('schedule-drift')).toHaveCount(0);

	await untick(page, accounts[1].short);
	const drift = page.getByTestId('schedule-drift');
	await expect(drift).toContainText(`${accounts[1].short} is still scheduled`);

	await page.getByTestId('schedule-drift-apply').click();
	await expect(page.getByTestId('schedule-panel')).toBeVisible();
	await expect(page.getByTestId('schedule-offsets')).toBeHidden();
	await page.getByTestId('schedule-confirm').click();

	await expect.poll(() => sent.length, { timeout: 20000 }).toBe(1);
	expect(sent[0].connectionIds).toEqual([accounts[0].id]);
	expect(sent[0].cancelOthers).toBe(true);
	await expect(page.getByTestId('publish-toast')).toContainText('Rescheduled for');
});

test('Unschedule turns the post back into a draft and keeps it open', async ({ page }) => {
	const { draftId, body, accounts } = await seedPost(page, [
		{ status: 'scheduled' },
		{ status: 'scheduled' }
	]);
	await openPost(page, draftId, body);
	await page.getByTestId('unschedule-post').click();

	await expect(page.getByTestId('publish-toast')).toContainText("it's a draft again");
	await expect(page.getByTestId('post-status')).toHaveCount(0);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body);
	await expect(page.getByTestId('publish-now')).toHaveText(/^\s*Publish\s*$/);
	expect(await targetStatuses(page, draftId)).toEqual({
		draft: 'draft',
		targets: { [accounts[0].id]: 'cancelled', [accounts[1].id]: 'cancelled' }
	});
});

test('Publish now unschedules the accounts left unticked', async ({ page }) => {
	const { draftId, body, accounts } = await seedPost(page, [
		{ status: 'scheduled' },
		{ status: 'scheduled' }
	]);
	await page.route(`**/api/drafts/${draftId}/publish`, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				results: [{ connectionId: accounts[0].id, status: 'published', skipped: false }]
			})
		})
	);
	await openPost(page, draftId, body);
	await untick(page, accounts[1].short);

	await clickUntilVisible(
		page,
		page.getByTestId('publish-now'),
		page.getByTestId('publish-confirm-destinations')
	);
	await expect(page.getByRole('dialog', { name: 'Confirm post' })).toContainText(
		'now instead of at the scheduled time'
	);
	await expect(page.getByTestId('publish-unschedules')).toContainText(accounts[1].short);
	await expect(page.getByTestId('confirm-dialog-ok')).toBeEnabled({ timeout: 20000 });
	await page.getByTestId('confirm-dialog-ok').click();

	await expect(page.getByTestId('publish-toast')).toContainText(
		`unscheduled on Bluesky · ${accounts[1].short}`
	);
	const after = await targetStatuses(page, draftId);
	expect(after.targets[accounts[1].id]).toBe('cancelled');
});

test('a post being sent pauses editing, then shows how it went', async ({ page }) => {
	const { draftId, body } = await seedPost(page, [{ status: 'scheduled', jobId: 'e2e-claim' }]);
	await openPost(page, draftId, body);

	await expect(page.getByTestId('post-status-sending')).toContainText('Editing is paused');
	await expect(page.getByTestId('segment-input-0')).toHaveAttribute('readonly', '');
	await expect(page.getByTestId('publish-now')).toHaveCount(0);
	await expect(page.getByTestId('unschedule-post')).toHaveCount(0);

	d1(
		`UPDATE publish_targets SET status='published', remote_post_id='remote-sent', job_id=NULL, scheduled_for=NULL WHERE draft_id='${draftId}'; ` +
			`UPDATE drafts SET status='published' WHERE id='${draftId}'`
	);
	await expect(page.getByTestId('published-lock')).toBeVisible({ timeout: 30000 });
	await expect(page.getByTestId('post-status')).toHaveCount(0);
});

test('a partly published post shows each account’s result', async ({ page }) => {
	const { draftId, body, accounts } = await seedPost(page, [
		{ status: 'published' },
		{ status: 'failed', error: 'The account was suspended' }
	]);
	await openPost(page, draftId, body);

	await expect(page.getByTestId('post-status-published')).toContainText(accounts[0].short);
	await expect(page.getByTestId('post-status-failed')).toContainText(
		`Failed on Bluesky · ${accounts[1].short}`
	);
	await expect(page.getByTestId('unschedule-post')).toHaveCount(0);
	// Still editable, so it can be fixed and sent again.
	await expect(page.getByTestId('segment-input-0')).not.toHaveAttribute('readonly', '');
	await expect(page.getByRole('button', { name: 'Delete post' })).toBeVisible();
});

test('an edit refused because the post started sending is kept and saved after', async ({
	page
}) => {
	const { draftId, body } = await seedPost(page, [{ status: 'scheduled' }]);
	await openPost(page, draftId, body);
	// The scheduler claims it after the composer last looked.
	d1(`UPDATE publish_targets SET job_id='e2e-claim' WHERE draft_id='${draftId}'`);

	const edited = `${body} edited`;
	await page.getByTestId('segment-input-0').fill(edited);
	await expect(page.getByTestId('post-status-sending')).toBeVisible({ timeout: 20000 });
	await expect(page.getByTestId('publish-toast')).toHaveCount(0);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(edited);

	// The claim ends without sending (a retry): the edit goes in after all.
	d1(`UPDATE publish_targets SET job_id=NULL WHERE draft_id='${draftId}'`);
	await expect(page.getByTestId('post-status-sending')).toHaveCount(0, { timeout: 30000 });
	await expect
		.poll(
			async () => (await (await page.request.get(`/api/drafts/${draftId}`)).json()).draft.baseBody,
			{ timeout: 20000 }
		)
		.toBe(edited);
});
