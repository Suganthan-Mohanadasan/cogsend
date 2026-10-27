import type { RequestHandler } from './$types';
import { approvalSnapshot, approvePost } from '#lib/server/approval-gate.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { fail, handleError, ok } from '#lib/server/http.js';
function time(raw: unknown) {
	if (raw === null || raw === undefined || raw === '') return null;
	if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw)))
		throw Object.assign(new Error('Invalid scheduledFor'), { status: 400 });
	return new Date(raw);
}
export const GET: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const connectionId = url.searchParams.get('connectionId');
		if (!connectionId) return fail('connectionId required');
		const snapshot = await approvalSnapshot(
			locals.db,
			locals.env,
			user.id,
			params.id,
			connectionId,
			time(url.searchParams.get('scheduledFor'))
		);
		return ok({ payload: snapshot.payload, hash: snapshot.hash });
	} catch (e) {
		return handleError(e);
	}
};
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'approve_schedule');
		const body = await request.json();
		if (
			typeof body.connectionId !== 'string' ||
			typeof body.hash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(body.hash)
		)
			return fail('connectionId and SHA-256 hash required');
		const channel = locals.authMethod === 'session' ? 'ui' : 'chat';
		return ok(
			await approvePost(
				locals.db,
				locals.env,
				user.id,
				locals.apiKeyId ?? user.id,
				channel,
				params.id,
				body.connectionId,
				time(body.scheduledFor),
				body.hash
			)
		);
	} catch (e) {
		return handleError(e);
	}
};
