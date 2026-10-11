export type PostsNotice = { message: string; tone: 'success' | 'warn' };

/**
 * One line for the Posts page to show after the composer sends you back to
 * it. Held in memory rather than in the URL or history state, so it appears
 * once and does not come back on Back or a reload.
 */
let pending: PostsNotice | null = null;

export function setPostsNotice(message: string, tone: PostsNotice['tone'] = 'success') {
	pending = { message, tone };
}

export function takePostsNotice(): PostsNotice | null {
	const notice = pending;
	pending = null;
	return notice;
}
