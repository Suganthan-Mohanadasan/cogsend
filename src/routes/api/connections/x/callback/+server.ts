import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { unpackXPendingSecret, xExchangeCode } from '#lib/server/providers/index.js';
import { xLimitFor } from '#lib/domain/x-limits.js';

export const GET = createOAuthCallback({
	platform: 'x',
	pendingMarker: 'x',
	accountIdKey: 'xUserId',
	reconcileMeta(incoming, existing) {
		// X can leave the plan out of a profile; the last one it gave still holds.
		const xSubscription = incoming.xSubscription ?? existing.xSubscription;
		const longPosts = typeof existing.longPosts === 'boolean' ? existing.longPosts : undefined;
		const meta = {
			...incoming,
			...(typeof xSubscription === 'string' ? { xSubscription } : {}),
			...(longPosts !== undefined ? { longPosts } : {})
		};
		return { ...meta, maxCharacters: xLimitFor(meta) };
	},
	async complete({ pending, code, env }) {
		const packed = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const { clientSecret, codeVerifier } = unpackXPendingSecret(packed);
		if (!codeVerifier) throw new Error('X connect session expired — try connecting again');
		const exchanged = await xExchangeCode({
			clientId: pending.clientId,
			clientSecret: clientSecret || undefined,
			code,
			codeVerifier,
			appUrl: env.APP_URL
		});
		return {
			credentials: {
				accessToken: exchanged.accessToken,
				refreshToken: exchanged.refreshToken,
				expiresAt: exchanged.expiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				...(clientSecret ? { clientSecret } : {}),
				xUserId: exchanged.xUserId,
				xUsername: exchanged.xUsername
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			meta: {
				xUserId: exchanged.xUserId,
				...(exchanged.xSubscription ? { xSubscription: exchanged.xSubscription } : {}),
				maxCharacters: exchanged.maxCharacters
			}
		};
	}
});
