/**
 * Fetching the latest release, with a cache.
 *
 * Workers share Cloudflare's egress addresses, and GitHub's unauthenticated API
 * allows 60 requests per hour *per address*, which strangers' traffic often
 * uses up. So the releases' Atom feed, a web page outside that limit, is asked
 * first, and the API only when the feed cannot answer. The answer is cached in
 * `app_settings`: an hour for a real answer, thirty minutes for a failure, so
 * a GitHub outage does not pin "unknown" for the rest of the day.
 *
 * Nothing here is allowed to break a page: every failure path returns a result
 * with `latest: null` and an `error` string, which Settings shows in one line.
 */
import {
	RELEASE_API_URL,
	RELEASES_API_URL,
	RELEASES_FEED_URL,
	newestOf,
	newestRelease,
	parseReleaseFeed,
	TAGS_API_URL,
	highestVersionTag,
	parseRelease,
	releaseCheckResult,
	type ReleaseCheck,
	type ReleaseInfo
} from '#lib/domain/release-check.js';
import { readAppSetting, writeAppSetting } from './app-settings';
import type { AppDb } from './db/client';

const CACHE_KEY = 'release_check';
/** '1' when Settings → Instance offers pre-releases too. */
export const OFFER_PRERELEASES_SETTING = 'offer_prereleases';
const OK_TTL_MS = 60 * 60_000;
const FAIL_TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 8_000;

interface CachedRelease {
	latest: ReleaseInfo | null;
	checkedAt: string;
	error?: string;
	/** Which answer this is, so switching the setting asks GitHub again. */
	prereleases?: boolean;
}

export async function readOfferPrereleases(db: AppDb): Promise<boolean> {
	return (await readAppSetting(db, OFFER_PRERELEASES_SETTING)) === '1';
}

export async function setOfferPrereleases(db: AppDb, on: boolean): Promise<void> {
	await writeAppSetting(db, OFFER_PRERELEASES_SETTING, on ? '1' : '');
}

function parseCache(raw: string | null): CachedRelease | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw) as CachedRelease;
		if (!data?.checkedAt) return null;
		return data;
	} catch {
		return null;
	}
}

function isFresh(cache: CachedRelease, now: number): boolean {
	const age = now - new Date(cache.checkedAt).getTime();
	if (Number.isNaN(age)) return false;
	return age < (cache.latest ? OK_TTL_MS : FAIL_TTL_MS);
}

/**
 * The latest release, from cache when it is fresh.
 *
 * `refresh` forces a fetch (the "Check now" affordance), and `fetchImpl` is for
 * tests. `current` defaults to the version this build reports.
 */
export async function checkForRelease(
	db: AppDb,
	options: { refresh?: boolean; fetchImpl?: typeof fetch; current?: string; now?: Date } = {}
): Promise<ReleaseCheck> {
	const current = options.current ?? __APP_VERSION__;
	const now = options.now ?? new Date();
	const cached = parseCache(await readAppSetting(db, CACHE_KEY));
	const prereleases = await readOfferPrereleases(db);

	if (
		cached &&
		!options.refresh &&
		(cached.prereleases ?? false) === prereleases &&
		isFresh(cached, now.getTime())
	) {
		return releaseCheckResult(current, cached.latest, cached.checkedAt, cached.error);
	}

	const doFetch = options.fetchImpl ?? fetch;
	const feed = await fromFeed(doFetch, prereleases);
	const { latest, error } = feed
		? { latest: feed, error: undefined }
		: await fromApi(doFetch, prereleases);

	const checkedAt = now.toISOString();
	await writeAppSetting(
		db,
		CACHE_KEY,
		JSON.stringify({ latest, checkedAt, error, prereleases } satisfies CachedRelease)
	);
	return releaseCheckResult(current, latest, checkedAt, error);
}

const GITHUB_HEADERS = {
	accept: 'application/vnd.github+json',
	// GitHub rejects requests without a User-Agent.
	'user-agent': 'cogsend'
};

/** The newest release from the Atom feed, or null for the API to answer instead. */
async function fromFeed(doFetch: typeof fetch, prereleases: boolean): Promise<ReleaseInfo | null> {
	try {
		const res = await doFetch(RELEASES_FEED_URL, {
			headers: { accept: 'application/atom+xml', 'user-agent': 'cogsend' },
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		return res.ok ? newestOf(parseReleaseFeed(await res.text()), prereleases) : null;
	} catch {
		return null;
	}
}

async function fromApi(
	doFetch: typeof fetch,
	prereleases: boolean
): Promise<{ latest: ReleaseInfo | null; error?: string }> {
	try {
		const res = await doFetch(prereleases ? RELEASES_API_URL : RELEASE_API_URL, {
			headers: GITHUB_HEADERS,
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (res.ok) {
			const body = await res.json().catch(() => null);
			const latest = prereleases ? newestRelease(body) : parseRelease(body);
			return latest
				? { latest }
				: { latest, error: 'GitHub returned an unexpected release document' };
		}
		if (res.status !== 404) return { latest: null, error: `GitHub answered HTTP ${res.status}` };
		// No published release object: fall back to tags, because a tag is what
		// a release actually marks. Still quiet if that fails too.
		const tags = await doFetch(TAGS_API_URL, {
			headers: GITHUB_HEADERS,
			signal: AbortSignal.timeout(TIMEOUT_MS)
		}).catch(() => null);
		if (!tags?.ok) return { latest: null, error: 'no releases or tags published yet' };
		const latest = highestVersionTag(await tags.json().catch(() => null));
		return latest ? { latest } : { latest, error: 'no version tags published yet' };
	} catch (err) {
		return { latest: null, error: err instanceof Error ? err.message : String(err) };
	}
}
