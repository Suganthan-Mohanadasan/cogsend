import { POST as mcpPOST } from '../src/routes/api/mcp/+server';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gateModule from '#lib/server/approval-gate.js';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import {
	connections,
	drafts,
	draftMedia,
	draftVariants,
	postApprovals,
	publishAudit,
	publishDispatches,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import {
	approvalSnapshot,
	approvePost,
	payloadHash,
	setPublishingHalted,
	publishingHalted
} from '#lib/server/approval-gate.js';
import { encryptJson } from '#lib/server/crypto.js';
import { publishTarget } from '#lib/server/publish.js';
import { scheduleDraft, retryDelivery, rescheduleDelivery } from '#lib/server/api/operations.js';
import { rotateApiKey, verifyApiKey, revokeApiKey } from '#lib/server/api-keys.js';
import { POST as approvalPOST } from '../src/routes/api/drafts/[id]/approval/+server';
import { POST as publishPOST } from '../src/routes/api/drafts/[id]/publish/+server';
import { POST as schedulePOST } from '../src/routes/api/drafts/[id]/schedule/+server';
import { POST as retryPOST } from '../src/routes/api/targets/[id]/retry/+server';
import { PATCH as killPATCH } from '../src/routes/api/publishing/+server';
import type { AppDb } from '#lib/server/db/client.js';
import type { FetchLike } from '#lib/server/providers/types.js';

describe.each(['libsql', 'd1'] as const)(
	'publishing policy through %s with fake platform HTTP',
	(driver) => {
		let db: AppDb, close: () => void;
		const now = () => new Date();
		const media = createTestMedia();
		const user = {
			id: 'user',
			email: 'owner@example.invalid',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		};
		let calls: string[];
		const locals = (scopes: string[] | null = null) => ({
			db,
			env: TEST_ENV,
			media,
			user,
			authMethod: scopes ? 'bearer' : 'session',
			apiKeyScopes: scopes,
			apiKeyId: scopes ? 'key-id' : undefined
		});
		const fake: FetchLike = async (input) => {
			calls.push(String(input));
			return Response.json({ id: 'remote-1', url: 'https://example.invalid/post/1' });
		};
		async function draft(id = 'draft', body = 'An approved post https://example.invalid/link') {
			await db
				.insert(drafts)
				.values({ id, userId: user.id, baseBody: body, createdAt: now(), updatedAt: now() });
		}
		async function target(id = 'target', draftId = 'draft', scheduledFor: Date | null = null) {
			await db.insert(publishTargets).values({
				id,
				draftId,
				connectionId: 'account',
				status: scheduledFor ? 'scheduled' : 'pending',
				scheduledFor,
				createdAt: now(),
				updatedAt: now()
			});
		}
		async function approve(draftId = 'draft', scheduledFor: Date | null = null) {
			const snapshot = await approvalSnapshot(
				db,
				TEST_ENV,
				user.id,
				draftId,
				'account',
				scheduledFor
			);
			return approvePost(
				db,
				TEST_ENV,
				user.id,
				'reviewer-key',
				'chat',
				draftId,
				'account',
				scheduledFor,
				snapshot.hash
			);
		}
		beforeEach(async () => {
			({ db, close } = await createTestDb(driver));
			calls = [];
			await db
				.insert(users)
				.values({ ...user, passwordHash: 'unused', createdAt: now(), updatedAt: now() });
			await db.insert(connections).values({
				id: 'account',
				userId: user.id,
				platform: 'mastodon',
				handle: 'owner@social.example.invalid',
				instanceUrl: 'https://social.example.invalid',
				credentialsEncrypted: await encryptJson(
					{ accessToken: 'fake-only', instanceUrl: 'https://social.example.invalid' },
					TEST_ENV.APP_ENCRYPTION_KEY
				),
				createdAt: now(),
				updatedAt: now()
			});
			await draft();
			await target();
		});
		afterEach(() => {
			vi.restoreAllMocks();
			close();
		});
		it('uses stable SHA-256 canonicalisation', async () => {
			expect(await payloadHash({ z: 1, a: { x: 2, y: 3 } })).toBe(
				await payloadHash({ a: { y: 3, x: 2 }, z: 1 })
			);
			expect(await payloadHash({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
		});
		it('blocks an unapproved target without a platform call and records needs_reapproval', async () => {
			const result = await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake });
			expect(result.status).toBe('failed');
			expect(calls).toEqual([]);
			expect((await db.select().from(publishTargets))[0].errorMessage).toBe('needs_reapproval');
			expect((await db.select().from(publishAudit)).map((a) => a.event)).toContain(
				'needs_reapproval'
			);
		});
		it('requires the exact hash and records who, when and channel', async () => {
			await expect(
				approvePost(
					db,
					TEST_ENV,
					user.id,
					'reviewer',
					'chat',
					'draft',
					'account',
					null,
					'0'.repeat(64)
				)
			).rejects.toThrow(/mismatch/);
			const { approval } = await approve();
			expect(approval).toMatchObject({ actor: 'reviewer-key', channel: 'chat', state: 'approved' });
			expect(approval.approvedAt).toBeInstanceOf(Date);
		});
		it('publishes approved content once and preserves remote evidence', async () => {
			await approve();
			const first = await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake });
			const second = await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake });
			expect(first.status).toBe('published');
			expect(second.skipped).toBe(true);
			expect(calls).toHaveLength(1);
			expect(
				(await db.select().from(publishAudit)).filter((a) => a.event === 'success')[0].detail
			).toContain('remote-1');
		});
		it.each(['text', 'title', 'variant', 'media', 'account'] as const)(
			'invalidates approval after a %s edit, including a revert',
			async (kind) => {
				await approve();
				if (kind === 'text') {
					await db.update(drafts).set({ baseBody: 'changed' }).where(eq(drafts.id, 'draft'));
					await db
						.update(drafts)
						.set({ baseBody: 'An approved post https://example.invalid/link' })
						.where(eq(drafts.id, 'draft'));
				}
				if (kind === 'title')
					await db.update(drafts).set({ title: 'new title' }).where(eq(drafts.id, 'draft'));
				if (kind === 'variant')
					await db.insert(draftVariants).values({
						id: 'variant',
						draftId: 'draft',
						platform: 'mastodon',
						body: 'override',
						createdAt: now(),
						updatedAt: now()
					});
				if (kind === 'media')
					await db.insert(draftMedia).values({
						id: 'media',
						draftId: 'draft',
						storageKey: 'object',
						mime: 'image/png',
						size: 4,
						createdAt: now()
					});
				if (kind === 'account')
					await db
						.update(connections)
						.set({ handle: 'changed@example.invalid' })
						.where(eq(connections.id, 'account'));
				expect((await db.select().from(postApprovals))[0].state).toBe('needs_reapproval');
				expect(
					(await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake })).status
				).toBe('failed');
				expect(calls).toHaveLength(0);
			}
		);
		it('binds the scheduled time and blocks tampering at send time', async () => {
			const when = new Date(Date.now() + 60_000);
			await approve('draft', when);
			await scheduleDraft(locals(), user.id, 'draft', {
				connectionIds: ['account'],
				runAt: when.toISOString()
			});
			await db
				.update(publishTargets)
				.set({ scheduledFor: new Date(Date.now() - 1000) })
				.where(eq(publishTargets.id, 'target'));
			expect((await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake })).status).toBe(
				'failed'
			);
			expect(calls).toHaveLength(0);
		});
		it('schedules and publishes only the approved time', async () => {
			const when = new Date(Date.now() + 60_000);
			await approve('draft', when);
			await scheduleDraft(locals(), user.id, 'draft', {
				connectionIds: ['account'],
				runAt: when.toISOString()
			});
			expect(
				(
					await publishTarget(db, TEST_ENV, media, 'target', {
						fetchImpl: fake,
						now: new Date(when.getTime() + 1)
					})
				).status
			).toBe('published');
			expect(calls).toHaveLength(1);
		});
		it('halts publishing through the setting and environment without API-key override', async () => {
			await approve();
			await setPublishingHalted(db, user.id, true);
			expect(
				(await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake })).error
			).toMatch(/halted/);
			await setPublishingHalted(db, user.id, false);
			expect(await publishingHalted(db, { ...TEST_ENV, PUBLISHING_HALTED: '1' })).toBe(true);
			expect(
				(
					await publishTarget(db, { ...TEST_ENV, PUBLISHING_HALTED: '1' }, media, 'target', {
						fetchImpl: fake
					})
				).error
			).toMatch(/halted/);
			expect(calls).toHaveLength(0);
		});
		it('stops the next call in a thread when the switch changes during a provider call', async () => {
			await db.update(drafts).set({ baseBody: 'one\n\n---\n\ntwo' }).where(eq(drafts.id, 'draft'));
			await db.insert(draftVariants).values({
				id: 'thread',
				draftId: 'draft',
				platform: 'mastodon',
				optionsJson: JSON.stringify({ threadSegments: ['one', 'two'] }),
				createdAt: now(),
				updatedAt: now()
			});
			await approve();
			const result = await publishTarget(db, TEST_ENV, media, 'target', {
				fetchImpl: async (input) => {
					calls.push(String(input));
					await setPublishingHalted(db, user.id, true);
					return Response.json({ id: 'first', url: 'https://example.invalid/first' });
				}
			});
			expect(result.status).toBe('failed');
			expect(calls).toHaveLength(1);
		});
		it('blocks all retries after an ambiguous provider response, including stale claims', async () => {
			await approve();
			const ambiguous: FetchLike = async () => {
				calls.push('accepted but response lost');
				throw new Error('connection reset');
			};
			expect(
				(await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: ambiguous })).status
			).toBe('failed');
			await expect(retryDelivery(locals(), user.id, 'target')).rejects.toThrow(/dispatched/);
			await db
				.update(publishTargets)
				.set({ status: 'publishing', updatedAt: new Date(0) })
				.where(eq(publishTargets.id, 'target'));
			expect((await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake })).status).toBe(
				'failed'
			);
			expect(calls).toHaveLength(1);
			expect((await db.select().from(publishDispatches))[0].state).toBe('uncertain');
		});
		it('deduplicates identical content across drafts and persists protection after deletion', async () => {
			await approve();
			await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake });
			await db.delete(drafts).where(eq(drafts.id, 'draft'));
			await draft('copy');
			await target('copy-target', 'copy');
			await approve('copy');
			expect(
				(await publishTarget(db, TEST_ENV, media, 'copy-target', { fetchImpl: fake })).status
			).toBe('failed');
			expect(calls).toHaveLength(1);
		});
		it('allows intentional repeats after the duplicate window', async () => {
			await approve();
			await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake });
			await db.run(sql`UPDATE publish_dedup SET reserved_at=0`);
			await draft('copy');
			await target('copy-target', 'copy');
			await approve('copy');
			expect(
				(await publishTarget(db, TEST_ENV, media, 'copy-target', { fetchImpl: fake })).status
			).toBe('published');
			expect(calls).toHaveLength(2);
		});
		it('serialises concurrent dispatches of the same approved target', async () => {
			await approve();
			await Promise.all([
				publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake }),
				publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake })
			]);
			expect(calls).toHaveLength(1);
			expect(await db.select().from(publishDispatches)).toHaveLength(1);
		});
		it('mock mode completes the pipeline without invoking the supplied network function', async () => {
			await approve();
			const result = await publishTarget(
				db,
				{ ...TEST_ENV, PUBLISHING_MODE: 'mock' },
				media,
				'target',
				{ fetchImpl: fake }
			);
			expect(result.remotePostId).toBe('mock:target');
			expect(calls).toHaveLength(0);
		});
		it('maintains independently revocable draft and approver keys', async () => {
			const a = await rotateApiKey(db, user.id, ['draft']),
				b = await rotateApiKey(db, user.id, ['approve_schedule']);
			expect((await verifyApiKey(db, a.raw))?.scopes).toEqual(['draft']);
			expect((await verifyApiKey(db, b.raw))?.scopes).toEqual(['approve_schedule']);
			await revokeApiKey(db, user.id, a.id);
			expect(await verifyApiKey(db, a.raw)).toBeNull();
			expect(await verifyApiKey(db, b.raw)).not.toBeNull();
		});
		it.each([
			['approve', approvalPOST],
			['publish', publishPOST],
			['schedule', schedulePOST],
			['retry', retryPOST]
		] as const)('draft keys cannot %s through REST', async (_, handler) => {
			const response = (await handler({
				locals: locals(['draft']),
				params: { id: 'draft' },
				request: new Request('https://example.invalid/api', {
					method: 'POST',
					body: '{}',
					headers: { 'Content-Type': 'application/json' }
				})
			} as never)) as Response;
			expect(response.status).toBe(403);
			expect(calls).toHaveLength(0);
		});
		it('approver keys cannot change the kill switch', async () => {
			const response = (await killPATCH({
				locals: locals(['approve_schedule']),
				request: new Request('https://example.invalid/api', {
					method: 'PATCH',
					body: '{"halted":false}'
				})
			} as never)) as Response;
			expect(response.status).toBe(401);
		});
		it('rejects rescheduling without approval for the new time', async () => {
			await approve();
			await expect(
				rescheduleDelivery(locals(), user.id, 'target', {
					runAt: new Date(Date.now() + 120_000).toISOString()
				})
			).rejects.toThrow(/needs_reapproval/);
		});
		it.each(['publish_draft', 'schedule_draft', 'retry_delivery', 'approve_draft'] as const)(
			'MCP draft keys cannot call %s',
			async (name) => {
				const args =
					name === 'retry_delivery'
						? { targetId: 'target' }
						: name === 'approve_draft'
							? { draftId: 'draft', connectionId: 'account', hash: '0'.repeat(64) }
							: {
									draftId: 'draft',
									connectionIds: ['account'],
									...(name === 'schedule_draft'
										? { runAt: new Date(Date.now() + 60_000).toISOString() }
										: {})
								};
				const request = new Request('https://example.invalid/api/mcp', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json, text/event-stream',
						'mcp-method': 'tools/call',
						'mcp-name': name,
						'mcp-protocol-version': '2026-07-28'
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'tools/call',
						params: {
							name,
							arguments: args,
							_meta: {
								[PROTOCOL_VERSION_META_KEY]: '2026-07-28',
								[CLIENT_CAPABILITIES_META_KEY]: {}
							}
						}
					})
				});
				const response = (await mcpPOST({
					request,
					url: new URL(request.url),
					locals: locals(['draft'])
				} as never)) as Response;
				const body = await response.json();
				expect(body.result.isError).toBe(true);
				expect(JSON.stringify(body.result)).toContain('Insufficient scope');
				expect(calls).toHaveLength(0);
			}
		);
		it('does not approve a payload that changed before the UI submitted its reviewed hash', async () => {
			const snapshot = await approvalSnapshot(db, TEST_ENV, user.id, 'draft', 'account', null);
			await db
				.update(drafts)
				.set({ baseBody: 'changed after preview' })
				.where(eq(drafts.id, 'draft'));
			const response = (await approvalPOST({
				params: { id: 'draft' },
				locals: locals(),
				request: new Request('https://example.invalid/api', {
					method: 'POST',
					body: JSON.stringify({ connectionId: 'account', hash: snapshot.hash })
				})
			} as never)) as Response;
			expect(response.status).toBe(409);
			expect(await db.select().from(postApprovals)).toHaveLength(0);
		});
		it('does not send prepared content under a replacement approval during the final rehash', async () => {
			await approve();
			const originalCheck = gateModule.checkTargetApproval;
			let checks = 0;
			vi.spyOn(gateModule, 'checkTargetApproval').mockImplementation(async (...args) => {
				if (++checks === 2) {
					await db
						.update(drafts)
						.set({ baseBody: 'newly reviewed replacement' })
						.where(eq(drafts.id, 'draft'));
					await approve();
				}
				return originalCheck(...args);
			});
			const result = await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake });
			expect(result.status).toBe('failed');
			expect(result.error).toContain('needs_reapproval');
			expect(calls).toHaveLength(0);
			expect(await db.select().from(publishDispatches)).toHaveLength(0);
		});
		it('fails closed if the policy database is unavailable', async () => {
			await approve();
			await db.run(sql`DROP TABLE post_approvals`);
			expect((await publishTarget(db, TEST_ENV, media, 'target', { fetchImpl: fake })).status).toBe(
				'failed'
			);
			expect(calls).toHaveLength(0);
		});
	}
);
