import type { RequestHandler } from './$types';
import { ownDraft } from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { expectedPartLength, readClaim, verifyUploadClaim } from '#lib/server/media-uploads.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/**
 * One part of an upload, streamed straight into storage. The claim travels in
 * the query string because the body is the bytes.
 */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const query = Object.fromEntries(url.searchParams);
		const claim = readClaim(params.id, query);
		if (!claim) return fail('Upload details required');
		if (!(await verifyUploadClaim(locals.env.APP_ENCRYPTION_KEY, claim, query.token ?? ''))) {
			return fail('Bad upload token', 403);
		}
		const n = Number(query.n);
		const expected = Number.isInteger(n) ? expectedPartLength(claim.size, n) : -1;
		if (expected < 0) return fail('Bad part number');
		// R2 needs every part but the last at one size, and a part longer than
		// the claim would let the stored file outgrow the checks it passed.
		const declared = Number(request.headers.get('content-length') ?? '');
		if (declared !== expected) return fail(`Part ${n} must be ${expected} bytes`, 400);
		if (!request.body) return fail('Part body required');
		if (!(await ownDraft(locals, params.id, user.id))) return fail('Not found', 404);
		if (!locals.media.multipart) return fail('This storage cannot take uploads in parts', 501);
		const part = await locals.media.multipart.uploadPart(
			claim.key,
			claim.uploadId,
			n,
			request.body
		);
		return ok(part);
	} catch (err) {
		return handleError(err);
	}
};
