import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, users } from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { SubrequestBudget } from '#lib/server/budget.js';
import { PUBLISH_RESERVE_CALLS } from '#lib/server/publish.js';
import {
	MASTODON_LIMITS_TTL_MS,
	refreshMastodonLimits,
	runSchedulerTick
} from '#lib/server/scheduler.js';

const NOW = new Date('2030-06-10T12:00:00.000Z');

describe('refreshMastodonLimits', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let asked: string[];

	const instance = (body: unknown, status = 200) =>
		(async (input: RequestInfo | URL) => {
			asked.push(String(input));
			return Response.json(body, { status });
		}) as typeof fetch;

	const limitsBody = {
		configuration: {
			statuses: { max_characters: 1000 },
			media_attachments: {
				video_size_limit: 200_000_000,
				video_matrix_limit: 8_294_400,
				video_frame_rate_limit: 120
			}
		}
	};

	async function account(opts: {
		host: string;
		meta?: Record<string, unknown>;
		platform?: string;
		status?: string;
	}) {
		const id = newId();
		await db.insert(connections).values({
			id,
			userId,
			platform: opts.platform ?? 'mastodon',
			handle: `me@${opts.host}`,
			instanceUrl: `https://${opts.host}`,
			credentialsEncrypted: 'enc',
			metaJson: JSON.stringify(opts.meta ?? {}),
			status: opts.status ?? 'active',
			createdAt: NOW,
			updatedAt: NOW
		});
		return id;
	}

	async function metaOf(id: string) {
		const [row] = await db.select().from(connections).where(eq(connections.id, id));
		return JSON.parse(row.metaJson) as Record<string, unknown>;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'limits@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: NOW,
			updatedAt: NOW
		});
	});
	beforeEach(async () => {
		asked = [];
		await db.delete(connections);
	});
	afterAll(() => close());

	it('reads the limits of an account never read, keeping what else it knows', async () => {
		const id = await account({ host: 'old.test', meta: { maxCharacters: 500, bot: false } });
		expect(
			await refreshMastodonLimits(db, TEST_ENV, { fetchImpl: instance(limitsBody), now: NOW })
		).toBe(1);
		expect(asked).toEqual(['https://old.test/api/v2/instance']);
		expect(await metaOf(id)).toEqual({
			bot: false,
			maxCharacters: 1000,
			videoSizeLimit: 200_000_000,
			videoMatrixLimit: 8_294_400,
			videoFrameRateLimit: 120,
			limitsReadAt: NOW.getTime()
		});
	});

	it('leaves accounts read within a day, and other platforms and states, alone', async () => {
		const fresh = await account({
			host: 'fresh.test',
			meta: { limitsReadAt: NOW.getTime() - MASTODON_LIMITS_TTL_MS + 60_000 }
		});
		await account({ host: 'bsky.test', platform: 'bluesky' });
		await account({ host: 'expired.test', status: 'expired' });
		expect(
			await refreshMastodonLimits(db, TEST_ENV, { fetchImpl: instance(limitsBody), now: NOW })
		).toBe(0);
		expect(asked).toEqual([]);
		expect((await metaOf(fresh)).videoSizeLimit).toBeUndefined();
	});

	it('keeps what it knew when the server does not answer, and asks again a day later', async () => {
		const id = await account({ host: 'down.test', meta: { videoSizeLimit: 40_000_000 } });
		await refreshMastodonLimits(db, TEST_ENV, {
			fetchImpl: instance({ error: 'down' }, 503),
			now: NOW
		});
		expect(await metaOf(id)).toEqual({ videoSizeLimit: 40_000_000, limitsReadAt: NOW.getTime() });

		asked = [];
		await refreshMastodonLimits(db, TEST_ENV, {
			fetchImpl: instance(limitsBody),
			now: new Date(NOW.getTime() + 60 * 60_000)
		});
		expect(asked).toEqual([]);
		await refreshMastodonLimits(db, TEST_ENV, {
			fetchImpl: instance(limitsBody),
			now: new Date(NOW.getTime() + MASTODON_LIMITS_TTL_MS)
		});
		expect((await metaOf(id)).videoSizeLimit).toBe(200_000_000);
	});

	it('asks a few servers a run, oldest first, and only with calls to spare', async () => {
		for (let i = 0; i < 5; i++) {
			await account({
				host: `s${i}.test`,
				meta: { limitsReadAt: NOW.getTime() - (10 - i) * MASTODON_LIMITS_TTL_MS }
			});
		}
		expect(
			await refreshMastodonLimits(db, TEST_ENV, { fetchImpl: instance(limitsBody), now: NOW })
		).toBe(3);
		expect(asked).toEqual([
			'https://s0.test/api/v2/instance',
			'https://s1.test/api/v2/instance',
			'https://s2.test/api/v2/instance'
		]);

		asked = [];
		const budget = new SubrequestBudget(50);
		budget.count(50 - (1 + PUBLISH_RESERVE_CALLS));
		expect(
			await refreshMastodonLimits(db, TEST_ENV, {
				fetchImpl: instance(limitsBody),
				budget,
				now: NOW
			})
		).toBe(0);
		expect(asked).toEqual([]);
	});

	it('runs with the hourly janitors, not on every tick', async () => {
		const id = await account({ host: 'tick.test' });
		await runSchedulerTick(db, TEST_ENV, {
			store: createTestMedia(),
			fetchImpl: instance(limitsBody)
		});
		expect(asked).toEqual(['https://tick.test/api/v2/instance']);
		expect((await metaOf(id)).videoSizeLimit).toBe(200_000_000);

		await account({ host: 'later.test' });
		asked = [];
		await runSchedulerTick(db, TEST_ENV, {
			store: createTestMedia(),
			fetchImpl: instance(limitsBody)
		});
		expect(asked).toEqual([]);
	});
});
