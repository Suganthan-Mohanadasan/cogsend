/**
 * Refusal for an edit to a post that has gone out everywhere. The composer
 * matches this exact text to switch a stale editor to its read-only view, so
 * the server and the editor must share it.
 */
export const PUBLISHED_EDIT_ERROR = 'Already published — duplicate it to post again';

/**
 * Refusal for an edit while a destination is being sent. Temporary: the
 * composer matches it to pause editing until the send settles.
 */
export const PUBLISH_IN_PROGRESS_ERROR = 'Publishing in progress — try again shortly';

/**
 * A post whose every live destination is published. Editing it would only
 * rewrite the record of what went out, not the posts themselves. Cancelled
 * targets are not destinations; a partial post (one account failed) stays
 * editable so it can be fixed and retried. A row with a remote id counts as
 * published even without the status, as the publish planner treats it.
 */
export function isFullyPublished(
	targets: ReadonlyArray<{ status?: string | null; remotePostId?: string | null }>
): boolean {
	const live = targets.filter((t) => t.status !== 'cancelled');
	return live.length > 0 && live.every((t) => t.status === 'published' || Boolean(t.remotePostId));
}
