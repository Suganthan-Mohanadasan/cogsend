import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { fillUntilKept, waitForLiveComposer, d1 } from './e2e-env';

/**
 * The header's Write on the compose page: hidden on an empty composer, and
 * otherwise it saves the open post before clearing for a new one, so an idea
 * can be parked mid-sentence without losing it.
 */

const PREFIX = 'new-post';
const connIds: string[] = [];

/** Leaves the shared e2e database as the other specs expect it. */
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

const write = (page: Page) => page.getByTestId('write-new-post');

async function storedBodies(page: Page): Promise<string[]> {
	const res = await page.request.get('/api/drafts?limit=100');
	const { drafts } = (await res.json()) as { drafts: Array<{ baseBody: string }> };
	return drafts.map((d) => d.baseBody).filter((b) => b.startsWith(PREFIX));
}

/** A post on one seeded (never contacted) account, scheduled or published. */
async function seedPost(page: Page, state: 'scheduled' | 'published') {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const userId = me.user.id as string;
	const connId = randomUUID();
	connIds.push(connId);
	const draftId = randomUUID();
	const body = `${PREFIX} ${state} ${draftId.slice(0, 8)}`;
	const now = Date.now();
	const target =
		state === 'scheduled'
			? `'scheduled', ${now + 2 * 60 * 60 * 1000}, NULL`
			: `'published', NULL, 'remote-${draftId.slice(0, 8)}'`;
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${userId}', 'bluesky', 'np-${connId.slice(0, 8)}.bsky.social', 'enc', '{}', 'active', ${now}, ${now}); ` +
			`INSERT INTO drafts (id, user_id, title, base_body, status, created_at, updated_at) VALUES ('${draftId}', '${userId}', NULL, '${body}', '${state}', ${now}, ${now}); ` +
			`INSERT INTO publish_targets (id, draft_id, connection_id, status, scheduled_for, remote_post_id, attempt_count, created_at, updated_at) VALUES ('${randomUUID()}', '${draftId}', '${connId}', ${target}, 0, ${now}, ${now})`
	);
	return { draftId, body };
}

test('Write appears once there is something to put away, and keeps it as a draft', async ({
	page
}) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	await expect(write(page)).toHaveCount(0);

	const text = `${PREFIX} first idea ${randomUUID().slice(0, 8)}`;
	await fillUntilKept(page.getByTestId('segment-input-0'), text);
	await expect(write(page)).toBeVisible();
	await write(page).click();

	await expect(page.getByTestId('publish-toast')).toContainText('Saved to drafts');
	await expect(page.getByTestId('toast-action')).toHaveAttribute('href', '/posts?tab=drafts');
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	await expect(page.getByTestId('segment-input-0')).toBeFocused();
	await expect(page).toHaveURL(/\/compose$/);
	await expect(write(page)).toHaveCount(0);
	expect(await storedBodies(page)).toContain(text);

	// The cleared post must not come back with the next account refresh.
	await page.waitForTimeout(1500);
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
});

test('a post typed just before Write is saved whole, and the next one is separate', async ({
	page
}) => {
	await page.goto('/compose');
	await waitForLiveComposer(page);
	const first = `${PREFIX} quick ${randomUUID().slice(0, 8)}`;
	// Typed and put away inside the autosave delay: Write does the saving.
	await page.getByTestId('segment-input-0').fill(first);
	await write(page).click();
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');

	const second = `${PREFIX} second ${randomUUID().slice(0, 8)}`;
	await fillUntilKept(page.getByTestId('segment-input-0'), second);
	await expect(page).toHaveURL(/\/compose\?id=/, { timeout: 20000 });
	await expect.poll(() => storedBodies(page), { timeout: 20000 }).toContain(second);
	const bodies = await storedBodies(page);
	expect(bodies).toContain(first);
	expect(bodies.filter((b) => b === first || b === second)).toHaveLength(2);
});

test('Write on a scheduled post saves the edit and leaves it scheduled', async ({ page }) => {
	const { draftId, body } = await seedPost(page, 'scheduled');
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('segment-input-0')).toHaveValue(body, { timeout: 20000 });
	await waitForLiveComposer(page);
	await expect(write(page)).toBeVisible();

	const edited = `${body} edited`;
	await page.getByTestId('segment-input-0').fill(edited);
	await write(page).click();

	await expect(page.getByTestId('publish-toast')).toContainText('Saved — still scheduled');
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	const { draft } = await (await page.request.get(`/api/drafts/${draftId}`)).json();
	expect(draft.baseBody).toBe(edited);
	expect(draft.targets.map((t: { status: string }) => t.status)).toEqual(['scheduled']);
});

test('Write on a published post just opens a new one', async ({ page }) => {
	const { draftId, body } = await seedPost(page, 'published');
	await page.goto(`/compose?id=${draftId}`);
	await expect(page.getByTestId('published-lock')).toBeVisible();
	await waitForLiveComposer(page);
	await write(page).click();

	await expect(page.getByTestId('published-lock')).toHaveCount(0);
	await expect(page.getByTestId('segment-input-0')).toHaveValue('');
	await expect(page.getByTestId('segment-input-0')).not.toHaveAttribute('readonly', '');
	const { draft } = await (await page.request.get(`/api/drafts/${draftId}`)).json();
	expect(draft.baseBody).toBe(body);
});
