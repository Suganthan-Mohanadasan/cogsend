import { desc } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { publishingHalted, setPublishingHalted } from '#lib/server/approval-gate.js';
import { publishAudit } from '#lib/server/db/schema.js';
import { requireScope, requireSession, requireUser } from '#lib/server/require.js';
import { fail, handleError, ok } from '#lib/server/http.js';
export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'read');
		return ok({
			halted: await publishingHalted(locals.db, locals.env),
			mode: locals.env.PUBLISHING_MODE ?? 'live',
			audit: await locals.db
				.select()
				.from(publishAudit)
				.orderBy(desc(publishAudit.createdAt))
				.limit(100)
		});
	} catch (e) {
		return handleError(e);
	}
};
export const PATCH: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = await request.json();
		if (typeof body.halted !== 'boolean') return fail('halted must be a boolean');
		await setPublishingHalted(locals.db, user.id, body.halted);
		return ok({ halted: await publishingHalted(locals.db, locals.env) });
	} catch (e) {
		return handleError(e);
	}
};
