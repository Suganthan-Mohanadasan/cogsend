import './fixtures/provider-policy-isolation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { POST as schedulePOST } from '../src/routes/api/drafts/[id]/schedule/+server';

/**
 * The composer sends its whole destination list with `cancelOthers`, so an
 * account taken off a scheduled post stops posting at the old time. Without
 * the flag the API keeps adding accounts one request at a time, as documented.
 */
describe('POST /api/drafts/[id]/schedule with cancelOthers', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const media = createTestMedia();

	const locals = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'others@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

	async function schedule(draftId: string, body: Record<string, unknown>) {
		const res = (await schedulePOST({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}/schedule`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: locals()
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function connection() {
		const now = new Date();
		const id = newId();
		await db.insert(connections).values({
			id,
			userId,
			platform: 'mastodon',
			handle: `${id}@mastodon.test`,
			credentialsEncrypted: '{}',
			metaJson: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function draft() {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'others probe',
			status: 'scheduled',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function target(
		draftId: string,
		connectionId: string,
		extra: Partial<typeof publishTargets.$inferInsert> = {}
	) {
		const now = new Date();
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status: 'scheduled',
			scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000),
			attemptCount: 0,
			createdAt: now,
			updatedAt: now,
			...extra
		});
	}

	const statusOf = async (draftId: string) =>
		Object.fromEntries(
			(await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId))).map(
				(t) => [t.connectionId, t.status]
			)
		);

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'others@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('cancels a deselected account that was still waiting', async () => {
		const [kept, dropped] = [await connection(), await connection()];
		const id = await draft();
		await target(id, kept);
		await target(id, dropped);
		const res = await schedule(id, {
			connectionIds: [kept],
			runAt: inAnHour(),
			cancelOthers: true
		});
		expect(res.status).toBe(200);
		expect(res.body.cancelled).toEqual([dropped]);
		expect(await statusOf(id)).toEqual({ [kept]: 'scheduled', [dropped]: 'cancelled' });
		const [row] = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.connectionId, dropped));
		expect(row.scheduledFor).toBeNull();
		const [stored] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(stored.status).toBe('scheduled');
	});

	it('leaves other accounts alone without the flag', async () => {
		const [kept, other] = [await connection(), await connection()];
		const id = await draft();
		await target(id, other);
		const res = await schedule(id, { connectionIds: [kept], runAt: inAnHour() });
		expect(res.status).toBe(200);
		expect(res.body.cancelled).toEqual([]);
		expect(await statusOf(id)).toEqual({ [kept]: 'scheduled', [other]: 'scheduled' });
	});

	it('never touches what went out, failed, or is being sent', async () => {
		const kept = await connection();
		const [published, failed, claimed, sending] = [
			await connection(),
			await connection(),
			await connection(),
			await connection()
		];
		const id = await draft();
		await target(id, published, { status: 'published', remotePostId: 'r-1', scheduledFor: null });
		await target(id, failed, { status: 'failed', errorMessage: 'no', scheduledFor: null });
		await target(id, claimed, { jobId: 'job-1' });
		await target(id, sending, { status: 'publishing', updatedAt: new Date() });
		const res = await schedule(id, {
			connectionIds: [kept],
			runAt: inAnHour(),
			cancelOthers: true
		});
		expect(res.status).toBe(200);
		expect(res.body.cancelled).toEqual([]);
		expect(await statusOf(id)).toEqual({
			[kept]: 'scheduled',
			[published]: 'published',
			[failed]: 'failed',
			[claimed]: 'scheduled',
			[sending]: 'publishing'
		});
	});

	it('refuses a flag that is not a boolean', async () => {
		const kept = await connection();
		const id = await draft();
		expect(
			await schedule(id, { connectionIds: [kept], runAt: inAnHour(), cancelOthers: 'yes' })
		).toEqual({ status: 400, body: { error: 'cancelOthers must be a boolean' } });
		expect(await statusOf(id)).toEqual({});
	});
});
