import { X_MAX_CHARS } from './validation/text';

/** What a paid X plan (Basic, Premium or Premium+) can post in one go. */
export const X_LONG_POST_MAX = 25_000;

/** Roughly where X's timeline folds a long post behind "Show more". */
export const X_FOLD = X_MAX_CHARS;

export interface XLimitMeta {
	/** The last `subscription_type` X reported for the account itself. */
	xSubscription?: string | null;
	/** The operator's own answer, which wins over what X reported. */
	longPosts?: boolean | null;
}

/**
 * Any plan but `None` posts long. X documents `Basic`, `Premium` and
 * `PremiumPlus`, and a name it adds later is more likely another paid plan
 * than a free one.
 */
export function isPaidXSubscription(type: string | null | undefined): boolean {
	const value = (type ?? '').trim();
	return value !== '' && value.toLowerCase() !== 'none';
}

/**
 * The limit an X account is held to. A Verified Organization can report
 * `None` and still post long, which is why the operator's switch decides
 * whenever it is set.
 */
export function xLimitFor(meta: XLimitMeta | null | undefined): number {
	const long =
		typeof meta?.longPosts === 'boolean'
			? meta.longPosts
			: isPaidXSubscription(meta?.xSubscription);
	return long ? X_LONG_POST_MAX : X_MAX_CHARS;
}

/** A stored limit, clamped to the two X knows; anything else is the free one. */
export function storedXLimit(value: unknown): number {
	return typeof value === 'number' && value >= X_MAX_CHARS && value <= X_LONG_POST_MAX
		? Math.floor(value)
		: X_MAX_CHARS;
}
