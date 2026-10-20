import type { RequestHandler } from './$types';
import { MAX_VIDEO_BYTES } from '#lib/domain/media-limits.js';
import {
	ownDraft,
	parseSegmentIndex,
	rejectIfNotEditable,
	videoSlotProblem
} from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import {
	newVideoKey,
	partCount,
	readClaim,
	signUploadClaim,
	UPLOAD_PART_BYTES,
	verifyUploadClaim
} from '#lib/server/media-uploads.js';
import { requireScope, requireUser } from '#lib/server/require.js';

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body = (await request.json()) as unknown;
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Start a video upload in parts. Every check that can refuse the video runs
 * here, before any bytes move; `complete` runs them again.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await readJson(request);
		if (!body) return fail('Invalid JSON');
		const size = Number(body.size);
		if (!Number.isInteger(size) || size <= 0) return fail('size required');
		if (size > MAX_VIDEO_BYTES) {
			return fail(`Video too large (max ${MAX_VIDEO_BYTES / 1_000_000}MB)`, 413);
		}
		if (String(body.mime ?? '').toLowerCase() !== 'video/mp4') {
			return fail('Only MP4 video goes up in parts');
		}
		const draft = await ownDraft(locals, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfNotEditable(locals.db, params.id);
		if (busy) return busy;
		const segmentIndex = parseSegmentIndex(body.segmentIndex);
		const problem = await videoSlotProblem(locals, draft, segmentIndex);
		if (problem) return problem;
		if (!locals.media.multipart) return fail('This storage cannot take uploads in parts', 501);
		const key = newVideoKey();
		const uploadId = await locals.media.multipart.create(key, 'video/mp4');
		const claim = { draftId: params.id, key, uploadId, size, segmentIndex };
		const token = await signUploadClaim(locals.env.APP_ENCRYPTION_KEY, claim);
		return ok({ ...claim, token, partSize: UPLOAD_PART_BYTES, parts: partCount(size) }, 201);
	} catch (err) {
		return handleError(err);
	}
};

/** Abandon an upload. R2 also drops unfinished ones on its own after 7 days. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await readJson(request);
		const claim = body ? readClaim(params.id, body) : null;
		if (!body || !claim) return fail('Upload details required');
		if (!(await verifyUploadClaim(locals.env.APP_ENCRYPTION_KEY, claim, String(body.token)))) {
			return fail('Bad upload token', 403);
		}
		if (!(await ownDraft(locals, params.id, user.id))) return fail('Not found', 404);
		await locals.media.multipart?.abort(claim.key, claim.uploadId).catch(() => {});
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
