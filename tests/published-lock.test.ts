import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { PUBLISHED_EDIT_ERROR, isFullyPublished } from '#lib/domain/published-lock.js';
import { DELETE as draftDELETE, PATCH as draftPATCH } from '../src/routes/api/drafts/[id]/+server';
import { POST as duplicatePOST } from '../src/routes/api/drafts/[id]/duplicate/+server';
import {
	DELETE as mediaDELETE,
	PATCH as mediaPATCH,
	POST as mediaPOST
} from '../src/routes/api/drafts/[id]/media/+server';
import {
	DELETE as variantDELETE,
	PUT as variantPUT
} from '../src/routes/api/drafts/[id]/variants/+server';

describe('isFullyPublished', () => {
	it('needs at least one live destination', () => {
		expect(isFullyPublished([])).toBe(false);
		expect(isFullyPublished([{ status: 'cancelled' }])).toBe(false);
	});

	it('is true when every live destination is published', () => {
		expect(isFullyPublished([{ status: 'published' }, { status: 'published' }])).toBe(true);
		expect(isFullyPublished([{ status: 'published' }, { status: 'cancelled' }])).toBe(true);
	});

	it('counts a remote id as published whatever the status says', () => {
		expect(isFullyPublished([{ status: 'failed', remotePostId: 'at://post/1' }])).toBe(true);
	});

	it('leaves a partly published or queued post editable', () => {
		expect(isFullyPublished([{ status: 'published' }, { status: 'failed' }])).toBe(false);
		expect(isFullyPublished([{ status: 'published' }, { status: 'scheduled' }])).toBe(false);
		expect(isFullyPublished([{ status: 'scheduled' }])).toBe(false);
	});
});

describe('editing a published post', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let mastodonId: string;
	let blueskyId: string;
	const media = createTestMedia();

	const locals = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'lock@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	async function call(
		handler: (event: never) => unknown,
		id: string,
		method: string,
		init: { body?: BodyInit; json?: unknown; query?: string } = {}
	) {
		const res = (await handler({
			params: { id },
			url: new URL(`http://localhost/api/drafts/${id}${init.query ?? ''}`),
			request: new Request(`http://localhost/api/drafts/${id}${init.query ?? ''}`, {
				method,
				...(init.json !== undefined
					? {
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(init.json)
						}
					: init.body !== undefined
						? { body: init.body }
						: {})
			}),
			locals: locals()
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function draftWith(targets: Array<Partial<typeof publishTargets.$inferInsert>>) {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'what went out',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		for (const [i, target] of targets.entries()) {
			await db.insert(publishTargets).values({
				id: newId(),
				draftId: id,
				connectionId: i === 0 ? mastodonId : blueskyId,
				status: 'published',
				attemptCount: 1,
				createdAt: now,
				updatedAt: now,
				...target
			});
		}
		return id;
	}

	const storedBody = async (id: string) =>
		(await db.select().from(drafts).where(eq(drafts.id, id)))[0]?.baseBody;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'lock@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		mastodonId = newId();
		blueskyId = newId();
		await db.insert(connections).values([
			{
				id: mastodonId,
				userId,
				platform: 'mastodon',
				handle: 'lock@mastodon.test',
				credentialsEncrypted: '{}',
				metaJson: '{}',
				status: 'active',
				createdAt: now,
				updatedAt: now
			},
			{
				id: blueskyId,
				userId,
				platform: 'bluesky',
				handle: 'lock.bsky.social',
				credentialsEncrypted: '{}',
				metaJson: '{}',
				status: 'active',
				createdAt: now,
				updatedAt: now
			}
		]);
	});

	afterAll(() => close());

	it('refuses every content change once all destinations are published', async () => {
		const id = await draftWith([{ remotePostId: 'm-1' }, { remotePostId: 'b-1' }]);
		const refused = { status: 409, body: { error: PUBLISHED_EDIT_ERROR } };
		expect(await call(draftPATCH, id, 'PATCH', { json: { baseBody: 'rewritten' } })).toEqual(
			refused
		);
		expect(
			await call(variantPUT, id, 'PUT', { json: { platform: 'bluesky', body: 'x', options: {} } })
		).toEqual(refused);
		expect(await call(variantDELETE, id, 'DELETE', { query: '?platform=bluesky' })).toEqual(
			refused
		);
		const form = new FormData();
		form.append('files', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png'));
		expect(await call(mediaPOST, id, 'POST', { body: form })).toEqual(refused);
		expect(
			await call(mediaPATCH, id, 'PATCH', { json: { mediaId: newId(), altText: 'alt' } })
		).toEqual(refused);
		expect(await call(mediaDELETE, id, 'DELETE', { query: `?mediaId=${newId()}` })).toEqual(
			refused
		);
		expect(await storedBody(id)).toBe('what went out');
	});

	it('ignores cancelled destinations when deciding', async () => {
		const id = await draftWith([{ remotePostId: 'm-2' }, { status: 'cancelled' }]);
		expect((await call(draftPATCH, id, 'PATCH', { json: { baseBody: 'x' } })).status).toBe(409);
	});

	it('still lets a partly published post be fixed and retried', async () => {
		const id = await draftWith([{ remotePostId: 'm-3' }, { status: 'failed', errorMessage: 'no' }]);
		const res = await call(draftPATCH, id, 'PATCH', { json: { baseBody: 'fixed' } });
		expect(res.status).toBe(200);
		expect(await storedBody(id)).toBe('fixed');
	});

	it('reports a publish in flight first, since that one passes', async () => {
		const id = await draftWith([{ remotePostId: 'm-4' }, { status: 'publishing' }]);
		expect(await call(draftPATCH, id, 'PATCH', { json: { baseBody: 'x' } })).toEqual({
			status: 409,
			body: { error: 'Publishing in progress — try again shortly' }
		});
	});

	it('can still be duplicated and deleted', async () => {
		const id = await draftWith([{ remotePostId: 'm-5' }]);
		const copy = await call(duplicatePOST, id, 'POST');
		expect(copy.status).toBe(201);
		const copyId = (copy.body.draft as { id: string }).id;
		expect((await call(draftPATCH, copyId, 'PATCH', { json: { baseBody: 'new' } })).status).toBe(
			200
		);
		expect((await call(draftDELETE, id, 'DELETE')).status).toBe(200);
		expect(await storedBody(id)).toBeUndefined();
	});
});
