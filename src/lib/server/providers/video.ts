import { videoMixProblem } from '#lib/domain/media-limits.js';
import {
	factsOfMedia,
	videoIssues,
	type VideoFacts,
	type VideoRuleMeta
} from '#lib/domain/video-rules.js';
import type { MediaAttachment, MediaReader, ValidationIssue } from './types';

export function isVideoAttachment(m: { mime?: string | null }): boolean {
	return (m.mime ?? '').toLowerCase().startsWith('video/');
}

/** The single video of a segment, or null when it carries images or nothing. */
export function segmentVideo(media: MediaAttachment[] | undefined): MediaAttachment | null {
	const list = media ?? [];
	return list.length === 1 && isVideoAttachment(list[0]) ? list[0] : null;
}

export function videoFactsOf(m: MediaAttachment): VideoFacts {
	return factsOfMedia({ ...m, meta: m.video });
}

/**
 * The composer's checks, run again at publish: an API client or an older draft
 * can reach here without them. Warnings stay in the composer.
 */
export function videoValidation(
	platform: string,
	media: MediaAttachment[] | undefined,
	meta: VideoRuleMeta | null | undefined,
	field: string
): ValidationIssue[] {
	const list = media ?? [];
	const videos = list.filter(isVideoAttachment);
	if (!videos.length) return [];
	const mix = videoMixProblem(videos.length, list.length - videos.length);
	if (mix) return [{ field, message: mix, code: 'video_mix' }];
	return videoIssues(platform, videoFactsOf(videos[0]), meta)
		.filter((issue) => issue.level === 'error')
		.map((issue) => ({ field, message: issue.message, code: 'video' }));
}

export const MISSING_VIDEO_MESSAGE = 'The video file is missing from storage — attach it again';

export function requireMediaReader(reader: MediaReader | undefined): MediaReader {
	if (!reader) throw new Error('Publishing a video needs the media store');
	return reader;
}

/** Bytes `start`..`end` inclusive of a stored video. */
export async function readVideoSlice(
	reader: MediaReader,
	storageKey: string,
	start: number,
	end: number
): Promise<Uint8Array> {
	const bytes = await reader.getRange(storageKey, start, end);
	if (!bytes) throw new Error(MISSING_VIDEO_MESSAGE);
	return bytes;
}

/** The size the store reports, which is what gets uploaded. */
export async function storedVideoSize(reader: MediaReader, storageKey: string): Promise<number> {
	const size = await reader.size(storageKey);
	if (size == null) throw new Error(MISSING_VIDEO_MESSAGE);
	return size;
}

/**
 * Workers send a stream of unknown length chunked, which upload endpoints
 * refuse; FixedLengthStream gives the request a Content-Length without
 * buffering the file. Elsewhere (tests, Node) the stream goes as it is.
 */
export function fixedLengthBody(body: ReadableStream, size: number): ReadableStream {
	const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream })
		.FixedLengthStream;
	return Fixed ? body.pipeThrough(new Fixed(size)) : body;
}

/** `before`, then the stored file as it streams, then `after`. */
export function wrapStream(
	before: Uint8Array,
	file: ReadableStream<Uint8Array>,
	after: Uint8Array
): ReadableStream<Uint8Array> {
	const reader = file.getReader();
	let started = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!started) {
				started = true;
				controller.enqueue(before);
				return;
			}
			const { done, value } = await reader.read();
			if (done) {
				controller.enqueue(after);
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

/**
 * Ask `check` until it answers, at most `polls` times and only while the
 * request has `reserve` calls left, sleeping between asks but never before
 * giving up. Null means "not ready": the caller parks the video.
 */
export async function pollVideo<T>(
	opts: { polls: number; delayMs: number; reserve: number; callsLeft?: () => number },
	check: () => Promise<T | null>
): Promise<T | null> {
	const callsLeft = opts.callsLeft ?? (() => Infinity);
	for (let poll = 0; poll < opts.polls && callsLeft() >= opts.reserve; poll++) {
		const done = await check();
		if (done !== null) return done;
		if (poll + 1 < opts.polls && callsLeft() >= opts.reserve) {
			await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
		}
	}
	return null;
}
