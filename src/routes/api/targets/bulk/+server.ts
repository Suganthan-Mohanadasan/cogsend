import { runAtError } from '#lib/domain/request-limits.js';
import type { RequestHandler } from './$types';
import { cancelDelivery, rescheduleDelivery, retryDelivery } from '#lib/server/api/operations.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';
export type BulkItemResult = { id: string; ok: boolean; status?: string; error?: string };
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'approve_schedule');
		const body = await request.json();
		if (!['cancel', 'retry', 'reschedule'].includes(body.op))
			return fail('op must be cancel, retry, or reschedule');
		if (
			!Array.isArray(body.ids) ||
			!body.ids.length ||
			body.ids.length > 10 ||
			body.ids.some((id: unknown) => typeof id !== 'string')
		)
			return fail('ids required (max 10)');
		if (body.op === 'reschedule') {
			const problem = runAtError(body.runAt, new Date());
			if (problem) return fail(problem);
		}
		const results: BulkItemResult[] = [];
		for (const id of [...new Set<string>(body.ids)]) {
			try {
				if (body.op === 'cancel') {
					await cancelDelivery(locals, user.id, id);
					results.push({ id, ok: true, status: 'cancelled' });
				} else if (body.op === 'reschedule') {
					await rescheduleDelivery(locals, user.id, id, body);
					results.push({ id, ok: true, status: 'scheduled' });
				} else {
					const result = await retryDelivery(locals, user.id, id);
					results.push({ id, ok: result.status !== 'failed', ...result });
				}
			} catch (e) {
				results.push({ id, ok: false, error: e instanceof Error ? e.message : 'Operation failed' });
			}
		}
		return ok({ results, failed: results.filter((r) => !r.ok) });
	} catch (e) {
		return handleError(e);
	}
};
