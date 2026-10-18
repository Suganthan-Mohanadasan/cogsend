import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { decryptJson, encryptJson, encryptSecret } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, drafts, oauthPending, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { platformLimit } from '#lib/domain/editor-limits.js';
import { isPaidXSubscription, storedXLimit, xLimitFor } from '#lib/domain/x-limits.js';
import { validatePost } from '#lib/server/api/operations.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { publishTarget } from '#lib/server/publish.js';
import { packXPendingSecret, xExchangeCode, xProvider } from '#lib/server/providers/x.js';
import { zernioProviderFor } from '#lib/server/providers/zernio.js';
import { ProviderError, PublishPartialError, type FetchLike } from '#lib/server/providers/types.js';
import { PATCH as connectionPATCH } from '../src/routes/api/connections/[id]/+server';
import { POST as verifyPOST } from '../src/routes/api/connections/[id]/verify/+server';
import { GET as xCallback } from '../src/routes/api/connections/x/callback/+server';

function mockFetch(
	handlers: Record<string, (req: Request) => Response | Promise<Response>>
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(new Request(url, init));
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
}

const long = 'a'.repeat(1000);

describe('the X limit an account is held to', () => {
	it('follows the plan X reports, with any plan but None posting long', () => {
		expect(xLimitFor({ xSubscription: 'Premium' })).toBe(25_000);
		expect(xLimitFor({ xSubscription: 'Basic' })).toBe(25_000);
		expect(xLimitFor({ xSubscription: 'PremiumPlus' })).toBe(25_000);
		expect(xLimitFor({ xSubscription: 'None' })).toBe(280);
		expect(xLimitFor({})).toBe(280);
		expect(xLimitFor(null)).toBe(280);
		expect(isPaidXSubscription('none')).toBe(false);
	});

	it('lets the operator overrule the report either way', () => {
		expect(xLimitFor({ xSubscription: 'None', longPosts: true })).toBe(25_000);
		expect(xLimitFor({ xSubscription: 'Premium', longPosts: false })).toBe(280);
	});

	it('treats a missing or odd stored limit as 280', () => {
		expect(storedXLimit(undefined)).toBe(280);
		expect(storedXLimit(500_000)).toBe(280);
		expect(storedXLimit(100)).toBe(280);
		expect(storedXLimit(25_000)).toBe(25_000);
	});

	it('holds the composer to the strictest selected X account', () => {
		const premium = { platform: 'x', metaJson: { maxCharacters: 25_000 } };
		const free = { platform: 'x', metaJson: { maxCharacters: 280 } };
		const viaZernio = { platform: 'x', metaJson: {} };
		expect(platformLimit('x', [premium])).toBe(25_000);
		expect(platformLimit('x', [premium, free])).toBe(280);
		expect(platformLimit('x', [premium, viaZernio])).toBe(280);
		expect(platformLimit('x', [])).toBe(280);
	});

	it('validates a post against the account limit on the server', () => {
		expect(xProvider.validate({ text: long }, { maxCharacters: 25_000 })).toEqual([]);
		const issues = xProvider.validate({ text: long }, { maxCharacters: 280 });
		expect(issues.map((i) => i.code)).toContain('max_length');
		expect(issues[0].message).toContain('X max 280');
	});

	it('keeps an account posting through Zernio at 280', () => {
		const issues = zernioProviderFor('x').validate({ text: long }, { maxCharacters: 25_000 });
		expect(issues.map((i) => i.code)).toContain('max_length');
	});

	it('does not let the validate tool hold X to 500', () => {
		const out = validatePost({ text: 'a'.repeat(400), platform: 'x' });
		expect(out.issues.map((i) => i.code)).toContain('max_length');
	});
});

describe('reading the plan from X', () => {
	it('stores what X reports at connect', async () => {
		const out = await xExchangeCode(
			{ clientId: 'CID', code: 'CODE', codeVerifier: 'V', appUrl: 'https://app.test' },
			mockFetch({
				'/2/oauth2/token': () => Response.json({ access_token: 'at', refresh_token: 'rt' }),
				'/2/users/me': (req) => {
					expect(new URL(req.url).searchParams.get('user.fields')).toContain('subscription_type');
					return Response.json({ data: { id: '1', username: 'u', subscription_type: 'Premium' } });
				}
			})
		);
		expect(out.xSubscription).toBe('Premium');
		expect(out.maxCharacters).toBe(25_000);
	});
	it('still connects when X will not show the plan', async () => {
		const asked: string[] = [];
		const out = await xExchangeCode(
			{ clientId: 'CID', code: 'CODE', codeVerifier: 'V', appUrl: 'https://app.test' },
			mockFetch({
				'/2/oauth2/token': () => Response.json({ access_token: 'at', refresh_token: 'rt' }),
				'/2/users/me': (req) => {
					const fields = new URL(req.url).searchParams.get('user.fields') ?? '';
					asked.push(fields);
					return fields.includes('subscription_type')
						? Response.json({ title: 'Field Authorization Error' }, { status: 403 })
						: Response.json({ data: { id: '1', username: 'u' } });
				}
			})
		);
		expect(asked).toHaveLength(2);
		expect(out.xUserId).toBe('1');
		expect(out.xSubscription).toBeUndefined();
		expect(out.maxCharacters).toBe(280);
	});
});

describe('when X refuses a long post', () => {
	const creds = { accessToken: 'tok', xUserId: '42' };

	it('says why and holds the account to 280', async () => {
		const err = await xProvider
			.publish(
				{ text: long },
				creds,
				undefined,
				mockFetch({
					'/2/tweets': () =>
						Response.json({ detail: 'Your Tweet text is too long.' }, { status: 400 })
				})
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).retryable).toBe(false);
		expect((err as ProviderError).message).toMatch(/Long posts need X Premium/);
		expect((err as ProviderError).metaPatch).toEqual({ maxCharacters: 280, longPosts: false });
	});

	it('does not read a duplicate long post as a missing plan', async () => {
		const err = await xProvider
			.publish(
				{ text: long },
				creds,
				undefined,
				mockFetch({
					'/2/tweets': () =>
						Response.json(
							{ detail: 'You are not allowed to create a Tweet with duplicate content.' },
							{ status: 403 }
						)
				})
			)
			.catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(ProviderError);
		expect((err as Error).message).toMatch(/duplicate content/);
	});

	it('leaves a refusal of a short post as it was', async () => {
		const err = await xProvider
			.publish(
				{ text: 'short' },
				creds,
				undefined,
				mockFetch({ '/2/tweets': () => new Response('nope', { status: 403 }) })
			)
			.catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(ProviderError);
		expect((err as Error).message).toMatch(/X post failed \(403\)/);
	});

	it('carries the change on a thread that stopped part-way', async () => {
		let n = 0;
		const err = await xProvider
			.publish(
				{ text: 'a', thread: [{ text: 'first' }, { text: long }] },
				creds,
				undefined,
				mockFetch({
					'/2/tweets': () =>
						++n === 1
							? Response.json({ data: { id: 't1' } }, { status: 201 })
							: new Response('not permitted', { status: 403 })
				})
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PublishPartialError);
		expect((err as PublishPartialError).segmentIds).toEqual(['t1']);
		expect((err as PublishPartialError).metaPatch).toEqual({
			maxCharacters: 280,
			longPosts: false
		});
	});
});

describe('long posts end to end', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const store = createTestMedia();

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'x-long@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	afterAll(() => close());

	async function xAccount(meta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform: 'x',
			handle: '@someone',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'tok', xUserId: '42', expiresAt: Date.now() + 3_600_000 },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ xUserId: '42', ...meta }),
			status: 'active',
			createdAt: now,
			updatedAt: now,
			...extra
		});
		return id;
	}
	const metaOf = async (id: string) =>
		JSON.parse(
			(await db.select().from(connections).where(eq(connections.id, id)))[0].metaJson
		) as Record<string, unknown>;

	const locals = (authMethod: 'session' | 'bearer' = 'session') => ({
		db,
		env: TEST_ENV,
		authMethod,
		apiKeyScopes: null,
		user: {
			id: userId,
			email: 'x-long@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});
	const patch = (id: string, body: unknown, authMethod: 'session' | 'bearer' = 'session') =>
		connectionPATCH({
			params: { id },
			locals: locals(authMethod),
			request: new Request('http://localhost/api/connections/' + id, {
				method: 'PATCH',
				body: JSON.stringify(body)
			})
		} as never) as Promise<Response>;

	it('a refused long post fails once, keeps the account connected and drops it to 280', async () => {
		const conn = await xAccount({ xSubscription: 'Premium', maxCharacters: 25_000 });
		const now = new Date();
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: long,
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: conn,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'/2/tweets': () =>
					Response.json({ detail: 'Your Tweet text is too long.' }, { status: 400 })
			})
		});
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/Long posts need X Premium/);
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		expect(row.status).toBe('active');
		expect(await metaOf(conn)).toMatchObject({ maxCharacters: 280, longPosts: false });
	});

	it('a thread stopped by a refused long post is not retried on its own', async () => {
		const conn = await xAccount({ xSubscription: 'Premium', maxCharacters: 25_000 });
		const now = new Date();
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: `first\n---\n${long}`,
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		const targetId = newId();
		await db.insert(publishTargets).values({
			id: targetId,
			draftId,
			connectionId: conn,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		let n = 0;
		const result = await publishTarget(db, TEST_ENV, store, targetId, {
			fetchImpl: mockFetch({
				'/2/tweets': () =>
					++n === 1
						? Response.json({ data: { id: 't1' } }, { status: 201 })
						: new Response('not permitted', { status: 403 })
			})
		});
		expect(n).toBe(2);
		expect(result.status).toBe('failed');
		expect(await metaOf(conn)).toMatchObject({ maxCharacters: 280, longPosts: false });
	});

	it('the switch overrides the plan, and null hands it back', async () => {
		const conn = await xAccount({ xSubscription: 'None', maxCharacters: 280 });
		const on = await patch(conn, { longPosts: true });
		expect(on.status).toBe(200);
		expect((await on.json()).connection.metaJson).toMatchObject({
			longPosts: true,
			maxCharacters: 25_000
		});
		expect((await patch(conn, { longPosts: null })).status).toBe(200);
		const meta = await metaOf(conn);
		expect(meta.longPosts).toBeUndefined();
		expect(meta.maxCharacters).toBe(280);
	});

	it('the switch refuses API keys, other platforms, Zernio accounts and bad values', async () => {
		const conn = await xAccount({});
		expect((await patch(conn, { longPosts: true }, 'bearer')).status).toBe(401);
		expect((await patch(conn, { longPosts: 'yes' })).status).toBe(400);
		expect((await patch(conn, {})).status).toBe(400);
		const zernio = await xAccount({ provider: 'zernio', zernioAccountId: 'a' });
		expect((await patch(zernio, { longPosts: true })).status).toBe(400);
		const masto = await xAccount({}, { platform: 'mastodon' });
		expect((await patch(masto, { longPosts: true })).status).toBe(400);
		expect((await patch(newId(), { longPosts: true })).status).toBe(404);
		expect((await metaOf(conn)).longPosts).toBeUndefined();
	});

	it('Check picks up a new plan and keeps the operator’s switch', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ data: { id: '42', username: 'someone', subscription_type: 'Premium' } })
			)
		);
		const auto = await xAccount({ xSubscription: 'None', maxCharacters: 280 });
		const forced = await xAccount({ xSubscription: 'None', longPosts: false, maxCharacters: 280 });
		for (const id of [auto, forced]) {
			const res = (await verifyPOST({ params: { id }, locals: locals() } as never)) as Response;
			expect(res.status).toBe(200);
		}
		expect(await metaOf(auto)).toMatchObject({ xSubscription: 'Premium', maxCharacters: 25_000 });
		expect(await metaOf(forced)).toMatchObject({
			xSubscription: 'Premium',
			longPosts: false,
			maxCharacters: 280
		});
	});

	/** Runs the X callback for an account that is already connected. */
	async function reconnect(conn: string, profile: Record<string, unknown>) {
		const pendingId = newId();
		await db.insert(oauthPending).values({
			id: pendingId,
			userId,
			instanceUrl: 'x',
			clientId: 'cid',
			clientSecretEnc: await encryptSecret(
				packXPendingSecret('secret', 'VERIFIER'),
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			expiresAt: new Date(Date.now() + 600_000),
			createdAt: new Date()
		});
		const state = await bindOAuthState({
			secret: TEST_ENV.AUTH_SECRET!,
			pendingId,
			sessionId: 'sess'
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) =>
				String(input).includes('/2/oauth2/token')
					? Response.json({ access_token: 'at2', refresh_token: 'rt2' })
					: Response.json({ data: profile })
			)
		);
		const location = await Promise.resolve(
			xCallback({
				url: new URL(
					`http://localhost/api/connections/x/callback?code=C&state=${encodeURIComponent(state)}`
				),
				locals: { db, env: TEST_ENV },
				cookies: { get: () => 'sess' }
			} as never)
		).then(
			() => '',
			(e: { location?: string }) => String(e?.location ?? '')
		);
		expect(location).toContain('connected=x');
		const [row] = await db.select().from(connections).where(eq(connections.id, conn));
		const creds = await decryptJson<{ accessToken?: string }>(
			row.credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		// The callback updated this row, not another X account in the database.
		expect(creds.accessToken).toBe('at2');
	}

	it('a reconnect keeps the operator’s switch', async () => {
		const conn = await xAccount({
			xUserId: '77',
			xSubscription: 'None',
			longPosts: true,
			maxCharacters: 25_000
		});
		await reconnect(conn, { id: '77', username: 'other', subscription_type: 'None' });
		expect(await metaOf(conn)).toMatchObject({
			xSubscription: 'None',
			longPosts: true,
			maxCharacters: 25_000
		});
	});

	it('a reconnect that X answers without a plan keeps the plan it gave before', async () => {
		const conn = await xAccount({
			xUserId: '78',
			xSubscription: 'Premium',
			maxCharacters: 25_000
		});
		await reconnect(conn, { id: '78', username: 'third' });
		expect(await metaOf(conn)).toMatchObject({ xSubscription: 'Premium', maxCharacters: 25_000 });
	});

	it('Check leaves the stored plan alone when X does not report one', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ data: { id: '42', username: 'someone' } }))
		);
		const conn = await xAccount({ xSubscription: 'Premium', maxCharacters: 25_000 });
		const res = (await verifyPOST({ params: { id: conn }, locals: locals() } as never)) as Response;
		expect(res.status).toBe(200);
		expect(await metaOf(conn)).toMatchObject({ xSubscription: 'Premium', maxCharacters: 25_000 });
	});
});
