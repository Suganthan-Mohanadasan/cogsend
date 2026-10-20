import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { newId } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import {
	cleanAltText,
	ownDraft,
	rejectIfNotEditable,
	videoSlotProblem
} from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import {
	deleteMediaObjects,
	probeStoredVideo,
	requirePlayableVideo,
	videoMetaFrom
} from '#lib/server/media.js';
import { partCount, readClaim, verifyUploadClaim } from '#lib/server/media-uploads.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { serializeMedia } from '#lib/server/serialize.js';

function readParts(value: unknown, count: number): { partNumber: number; etag: string }[] | null {
	if (!Array.isArray(value) || value.length !== count) return null;
	const parts: { partNumber: number; etag: string }[] = [];
	for (let i = 0; i < value.length; i++) {
		const part = value[i] as { partNumber?: unknown; etag?: unknown } | null;
		if (part?.partNumber !== i + 1 || typeof part.etag !== 'string' || !part.etag) return null;
		parts.push({ partNumber: i + 1, etag: part.etag });
	}
	return parts;
}

async function keyInUse(db: App.Locals['db'], key: string): Promise<boolean> {
	const rows = await db
		.select({ id: draftMedia.id })
		.from(draftMedia)
		.where(eq(draftMedia.storageKey, key))
		.limit(1);
	return rows.length > 0;
}

/**
 * Join the parts, then decide on what was actually stored: the size must be
 * the one the checks ran against, and the file must be a video the server can
 * read. Anything refused here is deleted, so a failed upload leaves nothing.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return fail('Invalid JSON');
		}
		const claim = body && typeof body === 'object' ? readClaim(params.id, body) : null;
		if (!claim) return fail('Upload details required');
		if (!(await verifyUploadClaim(locals.env.APP_ENCRYPTION_KEY, claim, String(body.token)))) {
			return fail('Bad upload token', 403);
		}
		const parts = readParts(body.parts, partCount(claim.size));
		if (!parts) return fail('parts must list every part in order');
		const draft = await ownDraft(locals, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfNotEditable(locals.db, params.id);
		if (busy) return busy;
		if (!locals.media.multipart) return fail('This storage cannot take uploads in parts', 501);

		const size = await locals.media.multipart.complete(claim.key, claim.uploadId, parts);
		let stored = false;
		try {
			if (size !== claim.size) return fail('The upload is not the size it started as');
			const facts = requirePlayableVideo(await probeStoredVideo(locals.media, claim.key, size));
			const problem = await videoSlotProblem(locals, draft, claim.segmentIndex);
			if (problem) return problem;
			const siblings = await locals.db
				.select({ id: draftMedia.id })
				.from(draftMedia)
				.where(
					and(eq(draftMedia.draftId, params.id), eq(draftMedia.segmentIndex, claim.segmentIndex))
				);
			const [media] = await locals.db
				.insert(draftMedia)
				.values({
					id: newId(),
					draftId: params.id,
					storageKey: claim.key,
					mime: 'video/mp4',
					size,
					width: facts.width,
					height: facts.height,
					metaJson: JSON.stringify(videoMetaFrom(facts)),
					altText: cleanAltText(body.altText),
					sortOrder: siblings.length,
					segmentIndex: claim.segmentIndex,
					createdAt: new Date()
				})
				.returning();
			stored = true;
			return ok({ media: serializeMedia(media) }, 201);
		} finally {
			// A replayed `complete` for an upload that already landed is refused
			// as a second video; the object it names belongs to the first row.
			if (!stored && !(await keyInUse(locals.db, claim.key))) {
				await deleteMediaObjects(locals.media, [claim.key]).catch(() => {});
			}
		}
	} catch (err) {
		return handleError(err);
	}
};
