import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { bytesToHex, utf8Bytes } from '#lib/domain/bytes.js';
import { batchQueries, first, newId, type AppDb } from '#lib/server/db/client.js';
import {
	appSettings,
	connections,
	draftMedia,
	draftRevisions,
	drafts,
	postApprovals,
	publishAudit,
	publishDispatches,
	publishDedup,
	publishTargets
} from '#lib/server/db/schema.js';
import { buildNormalizedPost } from '#lib/server/publish.js';
import { decryptJson } from '#lib/server/crypto.js';
import type { AppEnv } from '#lib/server/env.js';
import type { ConnectionCredentials } from '#lib/server/providers/index.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';

export const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000;
export const PUBLISHING_HALTED = 'publishing_halted';
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
			.join(',')}}`;
	return JSON.stringify(value) ?? 'null';
}
export async function payloadHash(value: unknown): Promise<string> {
	return bytesToHex(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', utf8Bytes(canonicalJson(value)) as BufferSource)
		)
	);
}
export function gateError(message: string): never {
	throw new ApiOperationError(message, 409);
}
export async function audit(
	db: AppDb,
	event: string,
	actor: string,
	draftId: string | null = null,
	targetId: string | null = null,
	detail: Record<string, unknown> = {}
) {
	await db.insert(publishAudit).values({
		id: newId(),
		event,
		actor,
		draftId,
		targetId,
		detail: JSON.stringify(detail),
		createdAt: new Date()
	});
}
export async function publishingHalted(db: AppDb, env: AppEnv): Promise<boolean> {
	const override = Boolean(
		env.PUBLISHING_HALTED && !['0', 'false', 'off'].includes(env.PUBLISHING_HALTED.toLowerCase())
	);
	const rows = await db
		.select()
		.from(appSettings)
		.where(inArray(appSettings.key, [PUBLISHING_HALTED, 'publishing_env_override']));
	if (rows.find((r) => r.key === 'publishing_env_override')?.value !== String(override)) {
		const at = Date.now();
		// A deployment changes bindings outside D1; record the first observation, atomically across isolates.
		await batchQueries(db, [
			db.insert(publishAudit)
				.select(sql`SELECT ${newId()},'kill_switch','environment',NULL,NULL,${JSON.stringify({ override, observed: true })},${at}
   WHERE COALESCE((SELECT value FROM app_settings WHERE key='publishing_env_override'),'') <> ${String(override)}`),
			db
				.insert(appSettings)
				.values({
					key: 'publishing_env_override',
					value: String(override),
					updatedAt: new Date(at)
				})
				.onConflictDoUpdate({
					target: appSettings.key,
					set: { value: String(override), updatedAt: new Date(at) }
				})
		]);
	}
	return override || rows.find((r) => r.key === PUBLISHING_HALTED)?.value === 'true';
}
export async function assertPublishingEnabled(db: AppDb, env: AppEnv) {
	if (await publishingHalted(db, env)) gateError('Publishing is halted');
}
export async function setPublishingHalted(db: AppDb, actor: string, halted: boolean) {
	const now = new Date();
	await batchQueries(db, [
		db
			.insert(appSettings)
			.values({ key: PUBLISHING_HALTED, value: String(halted), updatedAt: now })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value: String(halted), updatedAt: now }
			}),
		db.insert(publishAudit).values({
			id: newId(),
			event: 'kill_switch',
			actor,
			detail: JSON.stringify({ halted }),
			createdAt: now
		})
	]);
}
export async function approvalSnapshot(
	db: AppDb,
	env: AppEnv,
	userId: string,
	draftId: string,
	connectionId: string,
	scheduledFor: Date | null
) {
	const revision = await first(
		db.select().from(draftRevisions).where(eq(draftRevisions.draftId, draftId))
	);
	const draft = await first(
		db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	const conn = await first(
		db
			.select()
			.from(connections)
			.where(and(eq(connections.id, connectionId), eq(connections.userId, userId)))
	);
	if (!draft || !conn || !revision) throw new ApiOperationError('Not found', 404);
	const credentials = await decryptJson<ConnectionCredentials>(
		conn.credentialsEncrypted,
		env.APP_ENCRYPTION_KEY
	);
	const identityKeys = [
		'did',
		'personUrn',
		'openIdSub',
		'threadsUserId',
		'xUserId',
		'instanceUrl',
		'pdsHost',
		'handle',
		'zernioAccountId'
	] as const;
	const identity = Object.fromEntries(
		identityKeys
			.map((k) => [k, (credentials as Record<string, unknown>)[k]])
			.filter(([, v]) => v !== undefined)
	);
	const account = {
		platform: conn.platform,
		instanceUrl: conn.instanceUrl,
		handle: conn.handle,
		identity
	};
	const content = await buildNormalizedPost(db, draftId, conn.platform);
	const media = await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));
	const mediaIds = media
		.sort(
			(a, b) =>
				a.segmentIndex - b.segmentIndex || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
		)
		.map((m) => ({ id: m.id, storageKey: m.storageKey, meta: m.metaJson }));
	const payload = {
		version: 1,
		platform: conn.platform,
		connectionId,
		account,
		content,
		mediaIds,
		scheduledFor: scheduledFor?.toISOString() ?? null
	};
	const latest = await first(
		db.select().from(draftRevisions).where(eq(draftRevisions.draftId, draftId))
	);
	if (latest?.revision !== revision.revision)
		gateError('Content changed while being reviewed; reload the preview');
	return {
		payload,
		hash: await payloadHash(payload),
		contentHash: await payloadHash({
			content,
			mediaIds: mediaIds.map(({ storageKey, meta }) => ({ storageKey, meta }))
		}),
		accountHash: await payloadHash(account),
		revision: revision.revision,
		content,
		credentialsEncrypted: conn.credentialsEncrypted
	};
}
export async function approvePost(
	db: AppDb,
	env: AppEnv,
	userId: string,
	actor: string,
	channel: 'chat' | 'ui',
	draftId: string,
	connectionId: string,
	scheduledFor: Date | null,
	expectedHash: string
) {
	const snapshot = await approvalSnapshot(db, env, userId, draftId, connectionId, scheduledFor);
	if (snapshot.hash !== expectedHash)
		gateError('Content hash mismatch; review the final payload again');
	const id = newId(),
		now = new Date();
	await db.run(sql`INSERT INTO post_approvals (id,draft_id,connection_id,user_id,actor,channel,payload_hash,content_hash,account_hash,scheduled_for,revision,state,approved_at)
 SELECT ${id},${draftId},${connectionId},${userId},${actor},${channel},${snapshot.hash},${snapshot.contentHash},${snapshot.accountHash},${scheduledFor?.getTime() ?? null},${snapshot.revision},'approved',${now.getTime()}
 WHERE EXISTS (SELECT 1 FROM draft_revisions WHERE draft_id=${draftId} AND revision=${snapshot.revision})`);
	const record = await first(db.select().from(postApprovals).where(eq(postApprovals.id, id)));
	if (!record) gateError('Content changed while approving; review again');
	return { approval: record };
}
export async function requireApproval(
	db: AppDb,
	env: AppEnv,
	userId: string,
	draftId: string,
	connectionId: string,
	scheduledFor: Date | null
) {
	const snapshot = await approvalSnapshot(db, env, userId, draftId, connectionId, scheduledFor);
	const approval = await first(
		db
			.select()
			.from(postApprovals)
			.where(
				and(
					eq(postApprovals.draftId, draftId),
					eq(postApprovals.connectionId, connectionId),
					eq(postApprovals.userId, userId),
					eq(postApprovals.state, 'approved'),
					eq(postApprovals.payloadHash, snapshot.hash),
					eq(postApprovals.revision, snapshot.revision)
				)
			)
			.orderBy(desc(postApprovals.approvedAt))
			.limit(1)
	);
	if (!approval) {
		await audit(db, 'needs_reapproval', 'publisher', draftId, null, {
			connectionId,
			hash: snapshot.hash
		});
		gateError('needs_reapproval: approve the exact payload and scheduled time first');
	}
	return { approval, snapshot };
}
export async function checkTargetApproval(db: AppDb, env: AppEnv, targetId: string) {
	const target = await first(
		db.select().from(publishTargets).where(eq(publishTargets.id, targetId))
	);
	if (!target) gateError('Target not found');
	const draft = await first(db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft) gateError('Draft not found');
	try {
		return await requireApproval(
			db,
			env,
			draft.userId,
			target.draftId,
			target.connectionId,
			target.scheduledFor
		);
	} catch (err) {
		await db
			.update(postApprovals)
			.set({ state: 'needs_reapproval' })
			.where(
				and(
					eq(postApprovals.draftId, target.draftId),
					eq(postApprovals.connectionId, target.connectionId),
					eq(postApprovals.state, 'approved')
				)
			);
		await db
			.update(publishTargets)
			.set({
				status: 'failed',
				errorMessage: 'needs_reapproval',
				jobId: null,
				updatedAt: new Date()
			})
			.where(and(eq(publishTargets.id, targetId), sql`${publishTargets.status} <> 'published'`));
		throw err;
	}
}
export async function assertDispatchAllowed(db: AppDb, targetId: string) {
	const sent = await first(
		db.select().from(publishDispatches).where(eq(publishDispatches.targetId, targetId))
	);
	if (sent) gateError('Delivery already dispatched; reconcile its outcome before any new post');
}
export async function reserveDispatch(
	db: AppDb,
	targetId: string,
	approval: typeof postApprovals.$inferSelect
) {
	const now = Date.now();
	// D1 batches roll back together. Unique target tombstones survive draft deletion and all retry paths.

	await batchQueries(db, [
		db
			.insert(publishDedup)
			.values({
				accountHash: approval.accountHash,
				contentHash: approval.contentHash,
				targetId,
				reservedAt: new Date(now)
			})
			.onConflictDoUpdate({
				target: [publishDedup.accountHash, publishDedup.contentHash],
				set: { targetId, reservedAt: new Date(now) },
				setWhere: lt(publishDedup.reservedAt, new Date(now - DUPLICATE_WINDOW_MS))
			}),
		db.insert(publishDispatches)
			.select(sql`SELECT ${targetId},${approval.id},${approval.accountHash},${approval.contentHash},'uncertain',${now},NULL,NULL
  WHERE EXISTS (SELECT 1 FROM publish_dedup WHERE account_hash=${approval.accountHash} AND content_hash=${approval.contentHash} AND target_id=${targetId})
  AND EXISTS (SELECT 1 FROM post_approvals WHERE id=${approval.id} AND state='approved')`)
	]);

	const dispatch = await first(
		db.select().from(publishDispatches).where(eq(publishDispatches.targetId, targetId))
	);
	if (!dispatch)
		gateError('Duplicate content for this account within 24 hours, or approval revoked');
}
export async function checkBeforePlatformCall(
	db: AppDb,
	env: AppEnv,
	targetId: string,
	approval: typeof postApprovals.$inferSelect,
	credentialState?: { value: string }
) {
	const row = await first(
		db
			.select({
				state: postApprovals.state,
				revision: draftRevisions.revision,
				status: publishTargets.status,
				scheduledFor: publishTargets.scheduledFor,
				halted: appSettings.value,
				credentialsEncrypted: connections.credentialsEncrypted
			})
			.from(publishTargets)
			.innerJoin(postApprovals, eq(postApprovals.id, approval.id))
			.innerJoin(draftRevisions, eq(draftRevisions.draftId, publishTargets.draftId))
			.innerJoin(connections, eq(connections.id, publishTargets.connectionId))
			.leftJoin(appSettings, eq(appSettings.key, PUBLISHING_HALTED))
			.where(eq(publishTargets.id, targetId))
	);
	if (
		(env.PUBLISHING_HALTED &&
			!['0', 'false', 'off'].includes(env.PUBLISHING_HALTED.toLowerCase())) ||
		row?.halted === 'true'
	)
		gateError('Publishing is halted');
	if (
		!row ||
		row.state !== 'approved' ||
		row.revision !== approval.revision ||
		row.status !== 'publishing' ||
		row.scheduledFor?.getTime() !== approval.scheduledFor?.getTime()
	)
		gateError('needs_reapproval: content or delivery changed');
	// Token refresh can replace ciphertext without changing the destination. Rehash only that exceptional path.
	if (!credentialState || credentialState.value !== row.credentialsEncrypted) {
		const verified = await checkTargetApproval(db, env, targetId);
		if (verified.approval.payloadHash !== approval.payloadHash)
			gateError('needs_reapproval: account or payload changed');
		if (credentialState) credentialState.value = row.credentialsEncrypted;
	}
}
