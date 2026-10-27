import type { RequestHandler } from './$types';
import { parseApiScopes } from '#lib/domain/api-scopes.js';
import {
	getActiveApiKey,
	listApiKeys,
	revokeApiKey,
	revokeApiKeys,
	rotateApiKey
} from '#lib/server/api-keys.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';

function metadataOf(
	active: {
		prefix: string;
		createdAt: Date;
		lastUsedAt: Date | null;
		scopes?: string | string[] | null;
	} | null
) {
	if (!active) return null;
	return {
		prefix: active.prefix,
		createdAt: active.createdAt,
		lastUsedAt: active.lastUsedAt,
		scopes: parseApiScopes(
			Array.isArray(active.scopes) ? JSON.stringify(active.scopes) : active.scopes
		)
	};
}

// Session-only key management: a leaked API key authenticates as the user but
// must never mint its own replacement or lock the owner out, so these
// endpoints reject bearer auth outright (see requireSession).
export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const active = await getActiveApiKey(locals.db, user.id);
		return ok({
			active: metadataOf(active),
			keys: (await listApiKeys(locals.db, user.id)).map((k) => ({
				...k,
				scopes: parseApiScopes(k.scopes)
			}))
		});
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		// Malformed requests must not silently mint a key with broader permissions.
		const text = (await request?.text().catch(() => '')) ?? '';
		let body: unknown = {};
		if (text.trim()) {
			try {
				body = JSON.parse(text);
			} catch {
				return fail('Invalid JSON body', 400);
			}
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return fail('Invalid JSON body', 400);
		}
		if ('scopes' in body && !Array.isArray((body as { scopes?: unknown }).scopes)) {
			return fail('scopes must be an array', 400);
		}
		const requestedScopes = (body as { scopes?: unknown }).scopes;
		const { id, raw, prefix, createdAt, scopes } = await rotateApiKey(
			locals.db,
			user.id,
			requestedScopes
		);
		// The raw key is returned exactly once; only its hash is stored.
		return ok({ id, key: raw, prefix, createdAt, scopes, rotated: false }, 201);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const id = url?.searchParams.get('id');
		if (id) return ok({ ok: true, revoked: (await revokeApiKey(locals.db, user.id, id)).length });
		const revoked = await revokeApiKeys(locals.db, user.id);
		if (revoked === 0) return fail('No active API key', 404);
		return ok({ ok: true, revoked });
	} catch (err) {
		return handleError(err);
	}
};
