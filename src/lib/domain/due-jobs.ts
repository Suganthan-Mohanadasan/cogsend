/**
 * Dead-isolate TTL, not a request timeout: a claim nobody has renewed for this
 * long belongs to a run Cloudflare cut off, and until it passes the post shows
 * as Sending with nothing to press. Live runs renew well inside it.
 */
export const STALE_CLAIM_MS = 7 * 60_000;
/**
 * How often a live publish refreshes its claim. The heartbeat checks every
 * half of this, so renewals land at most 1.5× apart, comfortably inside
 * STALE_CLAIM_MS: an overlapping tick can never reclaim a publish that is
 * still running, and a slow one costs one extra write every few minutes.
 */
export const LEASE_REFRESH_MS = 2 * 60_000;

export type SchedulableTarget = {
	id: string;
	status: string;
	scheduledFor: Date | string | null;
	remotePostId?: string | null;
	updatedAt?: Date | string | null;
};

function asTime(value: Date | string | number | null | undefined): number | null {
	if (value == null) return null;
	if (typeof value === 'number') return Number.isNaN(value) ? null : value;
	const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(t) ? null : t;
}

/** True while a live isolate still owns the row. Missing updatedAt is treated as stale. */
export function isFreshPublishing(
	target: {
		status: string;
		updatedAt?: Date | string | number | null;
		remotePostId?: string | null;
	},
	now: Date = new Date()
): boolean {
	if (target.remotePostId) return false;
	if (target.status !== 'publishing') return false;
	const updated = asTime(target.updatedAt);
	if (updated == null) return false;
	return now.getTime() - updated < STALE_CLAIM_MS;
}

/** Default grace is 0 — never fire early. Pass a positive window only for catch-up. */
export function selectDueScheduledTargets<T extends SchedulableTarget>(
	targets: T[],
	now: Date = new Date(),
	graceMs = 0
): T[] {
	return targets.filter((t) => {
		// Status first: a published row is never due, even when the provider gave
		// us no id to remember it by.
		if (t.status === 'published' || t.remotePostId) return false;
		const when = asTime(t.scheduledFor);
		if (when != null && when > now.getTime() + graceMs) return false;

		if (t.status === 'publishing') {
			const updated = asTime(t.updatedAt);
			if (updated == null) return false;
			return updated <= now.getTime() - STALE_CLAIM_MS;
		}
		// `pending` with no timestamp is the "publish now" pair written by the
		// publish and retry paths just before their inline attempt. If that
		// attempt never ran (isolate evicted, request aborted, statement budget
		// spent) the row would otherwise be stranded: nothing else reaches it.
		if (t.status === 'pending' && when == null) return true;

		if (!t.scheduledFor || when == null) return false;
		return t.status === 'scheduled' || t.status === 'pending';
	});
}
