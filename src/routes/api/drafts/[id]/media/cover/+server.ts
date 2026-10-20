import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { validateImageUpload } from '#lib/domain/media-limits.js';
import { first, parseJson } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import { ownDraft, rejectIfNotEditable } from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { coverKey, type StoredVideoMeta } from '#lib/server/media.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { serializeMedia } from '#lib/server/serialize.js';

// Instagram takes covers up to 8 MB; a frame from the composer is a few hundred KB.
const MAX_COVER_BYTES = 8_000_000;

async function videoRow(locals: App.Locals, draftId: string, mediaId: string | null) {
	if (!mediaId) return null;
	const row = await first(
		locals.db
			.select()
			.from(draftMedia)
			.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, draftId)))
	);
	return row && (row.mime || '').toLowerCase().startsWith('video/') ? row : null;
}

async function guard(locals: App.Locals, draftId: string) {
	const user = requireUser(locals.user);
	requireScope(locals, 'write');
	if (!(await ownDraft(locals, draftId, user.id))) return fail('Not found', 404);
	return rejectIfNotEditable(locals.db, draftId);
}

/** Set a video's cover: a JPEG body, a frame the composer captured or an image. */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	try {
		const declared = Number(request.headers.get('content-length') ?? '');
		if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
			return fail('Cover must be 8MB or smaller', 413);
		}
		const blocked = await guard(locals, params.id);
		if (blocked) return blocked;
		const row = await videoRow(locals, params.id, url.searchParams.get('mediaId'));
		if (!row) return fail('Video not found', 404);
		const bytes = new Uint8Array(await request.arrayBuffer());
		const check = validateImageUpload({
			mime: 'image/jpeg',
			size: bytes.length,
			maxBytes: MAX_COVER_BYTES,
			bytes
		});
		if (!check.ok) return fail(check.message);
		// Every platform that takes a cover takes JPEG; Instagram takes nothing else.
		if (check.mime !== 'image/jpeg') return fail('Cover must be a JPEG');
		await locals.media.put(coverKey(row.storageKey), bytes, 'image/jpeg');
		const atParam = url.searchParams.get('atMs');
		const atMs = atParam === null || atParam === '' ? NaN : Number(atParam);
		const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
		meta.cover = {
			v: Date.now(),
			...(Number.isFinite(atMs) && atMs >= 0 ? { atMs: Math.round(atMs) } : {})
		};
		const [media] = await locals.db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify(meta) })
			.where(eq(draftMedia.id, row.id))
			.returning();
		return ok({ media: serializeMedia(media) });
	} catch (err) {
		return handleError(err);
	}
};

/** Back to the platforms' own choice of cover. */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const blocked = await guard(locals, params.id);
		if (blocked) return blocked;
		const row = await videoRow(locals, params.id, url.searchParams.get('mediaId'));
		if (!row) return fail('Video not found', 404);
		await locals.media.delete(coverKey(row.storageKey));
		const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
		delete meta.cover;
		const [media] = await locals.db
			.update(draftMedia)
			.set({ metaJson: JSON.stringify(meta) })
			.where(eq(draftMedia.id, row.id))
			.returning();
		return ok({ media: serializeMedia(media) });
	} catch (err) {
		return handleError(err);
	}
};
