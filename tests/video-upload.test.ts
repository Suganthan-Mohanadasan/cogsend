import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { probeMp4Bytes } from '#lib/domain/mp4-probe.js';
import { formatDuration, videoIssues } from '#lib/domain/video-rules.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { coverKey, memoryMediaStore } from '#lib/server/media.js';
import { UPLOAD_PART_BYTES } from '#lib/server/media-uploads.js';
import type { MediaStore } from '#lib/server/providers/types.js';
import { POST as mediaPOST } from '../src/routes/api/drafts/[id]/media/+server';
import {
	DELETE as coverDELETE,
	PUT as coverPUT
} from '../src/routes/api/drafts/[id]/media/cover/+server';
import {
	DELETE as uploadDELETE,
	POST as uploadPOST
} from '../src/routes/api/drafts/[id]/media/uploads/+server';
import { POST as completePOST } from '../src/routes/api/drafts/[id]/media/uploads/complete/+server';
import { PUT as partPUT } from '../src/routes/api/drafts/[id]/media/uploads/part/+server';
import { GET as mediaGET } from '../src/routes/api/media/[key]/+server';
import { buildMp4 } from './mp4-fixture';

describe('probeMp4', () => {
	it('reads duration, size, codecs and frame rate', async () => {
		const facts = await probeMp4Bytes(
			buildMp4({ durationMs: 12_500, width: 1920, height: 1080, fps: 30 })
		);
		expect(facts).toMatchObject({
			brand: 'isom',
			durationMs: 12_500,
			width: 1920,
			height: 1080,
			videoCodec: 'avc',
			audioCodec: 'aac',
			faststart: true
		});
		expect(facts?.fps).toBeCloseTo(30, 0);
	});

	it('names HEVC, reports a rotated picture by its displayed size, and spots a late index', async () => {
		const facts = await probeMp4Bytes(
			buildMp4({ video: 'hvc1', width: 1920, height: 1080, rotate90: true, faststart: false })
		);
		expect(facts).toMatchObject({
			videoCodec: 'hevc',
			width: 1080,
			height: 1920,
			faststart: false
		});
	});

	it('reads a QuickTime file the same way', async () => {
		const facts = await probeMp4Bytes(buildMp4({ brand: 'qt  ' }));
		expect(facts).toMatchObject({ brand: 'qt  ', videoCodec: 'avc' });
	});

	it('finds no video in an audio-only file, and nothing in a file that is not one', async () => {
		expect((await probeMp4Bytes(buildMp4({ video: null })))?.videoCodec).toBeNull();
		expect(await probeMp4Bytes(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
		expect(await probeMp4Bytes(new TextEncoder().encode('not a video at all, really'))).toBeNull();
	});
});

describe('videoIssues', () => {
	const fine = {
		durationMs: 30_000,
		width: 1080,
		height: 1920,
		size: 20_000_000,
		videoCodec: 'avc',
		fps: 30,
		faststart: true
	};
	const errors = (platform: string, facts: object, meta?: object) =>
		videoIssues(platform, { ...fine, ...facts }, meta as never).map((i) => i.message);

	it('passes an ordinary phone video everywhere', () => {
		for (const p of ['x', 'bluesky', 'mastodon', 'linkedin', 'threads']) {
			expect([p, errors(p, {})]).toEqual([p, []]);
		}
	});

	it('holds X to 2:20 unless the account has Premium', () => {
		const long = { durationMs: 200_000 };
		expect(errors('x', long)).toEqual([
			'X takes videos up to 2:20 — this one is 3:20. Accounts with X Premium can post longer ones.'
		]);
		expect(errors('x', long, { xSubscription: 'Premium' })).toEqual([]);
		// Zernio's route is not the account's own, so its plan does not count.
		expect(errors('x', long, { xSubscription: 'Premium', provider: 'zernio' })).toHaveLength(1);
	});

	it('names the codec, the shape and the frame rate X refuses', () => {
		expect(errors('x', { videoCodec: 'hevc' })).toEqual(['X needs H.264 video — this one is HEVC']);
		expect(errors('x', { width: 400, height: 1400 })).toEqual([
			'X takes videos between 1:3 and 3:1 — this one is 400×1400'
		]);
		expect(errors('x', { fps: 120 })).toEqual([
			'X takes videos up to 60 frames a second — this one is 120'
		]);
	});

	it('checks Threads for length, width, frame rate and where the index sits', () => {
		expect(errors('threads', { durationMs: 432_000 })).toEqual([
			'Threads takes videos up to 5:00 — this one is 7:12'
		]);
		expect(errors('threads', { width: 3840, height: 2160 })).toEqual([
			'Threads takes videos up to 1920 pixels wide — this one is 3840'
		]);
		expect(errors('threads', { fps: 15 })).toEqual([
			'Threads needs at least 23 frames a second — this one is 15'
		]);
		expect(errors('threads', { faststart: false })[0]).toMatch(/index at the start/);
		expect(errors('threads', { videoCodec: 'hevc' })).toEqual([]);
	});

	it('uses what a Mastodon server reports, and its defaults otherwise', () => {
		expect(errors('mastodon', { size: 120_000_000 })).toEqual([
			'Mastodon takes videos up to 99 MB — this one is 120 MB'
		]);
		expect(errors('mastodon', { size: 50_000_000 }, { videoSizeLimit: 40_000_000 })).toEqual([
			'Mastodon takes videos up to 40 MB — this one is 50 MB'
		]);
		expect(errors('mastodon', { width: 7680, height: 4320 })[0]).toMatch(/4K/);
	});

	it('checks LinkedIn and Bluesky for length', () => {
		expect(errors('linkedin', { durationMs: 2_000 })).toEqual([
			'LinkedIn needs a video of at least 3 seconds'
		]);
		expect(errors('bluesky', { durationMs: 11 * 60_000 })).toEqual([
			'Bluesky takes videos up to 10:00 — this one is 11:00'
		]);
	});

	it('skips what the server could not read', () => {
		expect(videoIssues('x', { size: 1000 })).toEqual([]);
	});

	it('formats durations the way people read them', () => {
		expect(formatDuration(140_000)).toBe('2:20');
		expect(formatDuration(3_725_000)).toBe('1:02:05');
	});
});

describe('video uploads', () => {
	let db: AppDb;
	let close: () => void;
	let media: MediaStore;
	const userId = newId();
	const user = {
		id: userId,
		email: 'video@localhost',
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true
	};
	const locals = () => ({ db, media, env: TEST_ENV, user });

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: user.email,
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	async function newDraft(body = 'one card') {
		const id = newId();
		const now = new Date();
		await db
			.insert(drafts)
			.values({ id, userId, baseBody: body, status: 'draft', createdAt: now, updatedAt: now });
		return id;
	}

	function json(body: unknown) {
		return new Request('http://localhost/x', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
	}

	async function start(draftId: string, size: number, segmentIndex = 0) {
		const res = (await uploadPOST({
			params: { id: draftId },
			request: json({ size, mime: 'video/mp4', segmentIndex }),
			locals: locals()
		} as never)) as Response;
		return { res, body: (await res.json()) as Record<string, unknown> };
	}

	async function sendPart(
		draftId: string,
		claim: Record<string, unknown>,
		n: number,
		bytes: Uint8Array<ArrayBuffer>
	) {
		const q = new URLSearchParams({
			key: String(claim.key),
			uploadId: String(claim.uploadId),
			size: String(claim.size),
			segmentIndex: String(claim.segmentIndex),
			token: String(claim.token),
			n: String(n)
		});
		const url = new URL(`http://localhost/x?${q}`);
		const res = (await partPUT({
			params: { id: draftId },
			url,
			request: new Request(url, {
				method: 'PUT',
				headers: { 'Content-Length': String(bytes.length) },
				body: bytes
			}),
			locals: locals()
		} as never)) as Response;
		return { res, body: (await res.json()) as Record<string, unknown> };
	}

	async function complete(draftId: string, claim: Record<string, unknown>, parts: unknown[]) {
		const res = (await completePOST({
			params: { id: draftId },
			request: json({ ...claim, parts, altText: '  a clip  ' }),
			locals: locals()
		} as never)) as Response;
		return { res, body: (await res.json()) as Record<string, unknown> };
	}

	async function uploadWhole(draftId: string, bytes: Uint8Array, segmentIndex = 0) {
		const { body: claim } = await start(draftId, bytes.length, segmentIndex);
		const parts = [];
		for (let n = 1, at = 0; at < bytes.length; n++, at += UPLOAD_PART_BYTES) {
			const { body } = await sendPart(draftId, claim, n, bytes.slice(at, at + UPLOAD_PART_BYTES));
			parts.push(body);
		}
		return { claim, ...(await complete(draftId, claim, parts)) };
	}

	beforeAll(() => {
		media = memoryMediaStore();
	});

	it('stores a video sent in parts, with what the server read from it', async () => {
		const draftId = await newDraft();
		// Two full parts and a short last one.
		const bytes = buildMp4({ durationMs: 95_000, mdatBytes: UPLOAD_PART_BYTES * 2 + 1234 });
		const { res, body, claim } = await uploadWhole(draftId, bytes);
		expect(res.status).toBe(201);
		expect(claim.parts).toBe(3);
		const row = (await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId)))[0];
		expect(row).toMatchObject({
			storageKey: claim.key,
			mime: 'video/mp4',
			size: bytes.length,
			width: 1280,
			height: 720,
			altText: 'a clip'
		});
		expect(JSON.parse(row.metaJson!)).toMatchObject({
			durationMs: 95_000,
			videoCodec: 'avc',
			audioCodec: 'aac',
			faststart: true
		});
		expect((body.media as { meta: { durationMs: number } }).meta.durationMs).toBe(95_000);
		// Compared as one buffer: an element-wise diff of 20 MB takes minutes.
		const stored = await media.get(String(claim.key));
		expect(stored && Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true);
	});

	it('refuses a token that does not match the claim', async () => {
		const draftId = await newDraft();
		const { body: claim } = await start(draftId, 100);
		const { res } = await sendPart(draftId, { ...claim, size: 200 }, 1, new Uint8Array(200));
		expect(res.status).toBe(403);
		const other = await newDraft();
		const { res: elsewhere } = await sendPart(other, claim, 1, new Uint8Array(100));
		expect(elsewhere.status).toBe(403);
	});

	it('refuses a part of the wrong length', async () => {
		const draftId = await newDraft();
		const { body: claim } = await start(draftId, UPLOAD_PART_BYTES + 10);
		const { res, body } = await sendPart(draftId, claim, 1, new Uint8Array(100));
		expect(res.status).toBe(400);
		expect(body.error).toBe(`Part 1 must be ${UPLOAD_PART_BYTES} bytes`);
		const { res: past } = await sendPart(draftId, claim, 3, new Uint8Array(10));
		expect(past.status).toBe(400);
	});

	it('deletes what was stored when the file is not a video, and leaves no row', async () => {
		const draftId = await newDraft();
		const bytes = new TextEncoder().encode('plain text pretending to be a video file');
		const { res, body, claim } = await uploadWhole(draftId, bytes);
		expect(res.status).toBe(400);
		expect(body.error).toMatch(/Could not read this video/);
		expect(await media.get(String(claim.key))).toBeNull();
		expect(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId))).toEqual([]);
	});

	it('refuses a second video, or images, on the same card before any bytes move', async () => {
		const draftId = await newDraft();
		expect((await uploadWhole(draftId, buildMp4())).res.status).toBe(201);
		const { res, body } = await start(draftId, 1000);
		expect(res.status).toBe(400);
		expect(body.error).toBe('Only one video per post');
		const form = new FormData();
		form.set('segmentIndex', '0');
		form.append(
			'files',
			new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], 'p.png', {
				type: 'image/png'
			})
		);
		const image = (await mediaPOST({
			params: { id: draftId },
			request: new Request('http://localhost/x', { method: 'POST', body: form }),
			locals: locals()
		} as never)) as Response;
		expect(image.status).toBe(400);
	});

	it('keeps the first of two uploads that raced for one card, and survives a replayed complete', async () => {
		const draftId = await newDraft();
		const bytes = buildMp4();
		const { body: a } = await start(draftId, bytes.length);
		const { body: b } = await start(draftId, bytes.length);
		const partA = (await sendPart(draftId, a, 1, bytes)).body;
		const partB = (await sendPart(draftId, b, 1, bytes)).body;
		expect((await complete(draftId, a, [partA])).res.status).toBe(201);
		const late = await complete(draftId, b, [partB]);
		expect(late.res.status).toBe(400);
		expect(late.body.error).toBe('Only one video per post');
		expect(await media.get(String(b.key))).toBeNull();

		// Storage that answers a second complete for a finished upload, as S3 can.
		const plain = media;
		const finished = new Map<string, number>();
		media = {
			...plain,
			multipart: {
				...plain.multipart!,
				async complete(key, uploadId, parts) {
					const done = finished.get(uploadId);
					if (done !== undefined) return done;
					const size = await plain.multipart!.complete(key, uploadId, parts);
					finished.set(uploadId, size);
					return size;
				}
			}
		};
		try {
			const other = await newDraft();
			const { body: c } = await start(other, bytes.length);
			const partC = (await sendPart(other, c, 1, bytes)).body;
			expect((await complete(other, c, [partC])).res.status).toBe(201);
			expect((await complete(other, c, [partC])).res.status).toBe(400);
			expect(await media.get(String(c.key))).not.toBeNull();
		} finally {
			media = plain;
		}
	});

	it('refuses a card the draft does not have, and a video over the cap', async () => {
		const draftId = await newDraft();
		expect((await start(draftId, 1000, 3)).res.status).toBe(400);
		expect((await start(draftId, 300_000_001)).res.status).toBe(413);
	});

	it('abandons an upload on request', async () => {
		const draftId = await newDraft();
		const { body: claim } = await start(draftId, 100);
		const res = (await uploadDELETE({
			params: { id: draftId },
			request: json(claim),
			locals: locals()
		} as never)) as Response;
		expect(res.status).toBe(200);
		const { res: late } = await sendPart(draftId, claim, 1, new Uint8Array(100));
		expect(late.status).toBe(500);
	});

	it('still takes a small video through the form route, and refuses one it cannot read', async () => {
		const draftId = await newDraft();
		const send = (bytes: Uint8Array<ArrayBuffer>) => {
			const form = new FormData();
			form.set('segmentIndex', '0');
			form.append('files', new File([bytes], 'clip.mp4', { type: 'video/mp4' }));
			return mediaPOST({
				params: { id: draftId },
				request: new Request('http://localhost/x', { method: 'POST', body: form }),
				locals: locals()
			} as never) as Promise<Response>;
		};
		const fake = await send(
			new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
		);
		expect(fake.status).toBe(400);
		const real = await send(buildMp4({ durationMs: 4_000 }));
		expect(real.status).toBe(201);
		const row = (await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId)))[0];
		expect(JSON.parse(row.metaJson!).durationMs).toBe(4_000);
	});

	it('keeps a cover beside the video, serves it, and removes it', async () => {
		const draftId = await newDraft();
		const { claim, body } = await uploadWhole(draftId, buildMp4());
		const mediaId = (body.media as { id: string }).id;
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
		const put = (bytes: Uint8Array<ArrayBuffer>, at = '&atMs=1500') => {
			const url = new URL(`http://localhost/x?mediaId=${mediaId}${at}`);
			return coverPUT({
				params: { id: draftId },
				url,
				request: new Request(url, { method: 'PUT', body: bytes }),
				locals: locals()
			} as never) as Promise<Response>;
		};
		const png = await put(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
		expect(png.status).toBe(400);
		const res = await put(jpeg);
		expect(res.status).toBe(200);
		const cover = (
			(await res.json()) as { media: { meta: { cover: { v: number; atMs: number } } } }
		).media.meta.cover;
		expect(cover.atMs).toBe(1500);
		expect(await media.get(coverKey(String(claim.key)))).toEqual(jpeg);
		const uploaded = (await (await put(jpeg, '')).json()) as {
			media: { meta: { cover: { atMs?: number } } };
		};
		expect(uploaded.media.meta.cover.atMs).toBeUndefined();

		const served = (await mediaGET({
			params: { key: claim.key },
			url: new URL(`http://localhost/x?cover=${cover.v}`),
			request: new Request('http://localhost/x'),
			locals: { ...locals(), bindings: {} }
		} as never)) as Response;
		expect(served.headers.get('Content-Type')).toBe('image/jpeg');
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg);

		const del = (await coverDELETE({
			params: { id: draftId },
			url: new URL(`http://localhost/x?mediaId=${mediaId}`),
			locals: locals()
		} as never)) as Response;
		expect(del.status).toBe(200);
		expect(await media.get(coverKey(String(claim.key)))).toBeNull();
	});
});
