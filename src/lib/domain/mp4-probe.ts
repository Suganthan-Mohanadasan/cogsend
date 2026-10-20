/**
 * What a stored MP4 (or MOV) says about itself, read from its boxes.
 *
 * The server reads this once, when a video is stored, so every platform's
 * rules can be checked against it later without touching the file again. It
 * reads box headers and the `moov` box only, through a range reader, so a
 * 300 MB video never sits in Worker memory.
 */
export interface Mp4Facts {
	/** ftyp major brand, e.g. `isom`, `mp42`, `qt  `. */
	brand: string;
	durationMs: number;
	/** Display size: rotation applied. Null without a video track. */
	width: number | null;
	height: number | null;
	/** `avc`, `hevc`, `av1`, `vp9`, or the raw sample entry for anything else. */
	videoCodec: string | null;
	audioCodec: string | null;
	fps: number | null;
	/** The index (`moov`) comes before the media data, which Meta requires. */
	faststart: boolean;
}

/** Inclusive byte range, or null when the object is gone. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array | null>;

// A ten-minute 1080p video has a moov of a few MB; anything far beyond this is
// not a video CogSend can publish, and reading it would cost Worker memory.
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 64;

const VIDEO_CODECS: Record<string, string> = {
	avc1: 'avc',
	avc3: 'avc',
	hvc1: 'hevc',
	hev1: 'hevc',
	av01: 'av1',
	vp09: 'vp9'
};
const AUDIO_CODECS: Record<string, string> = {
	mp4a: 'aac',
	Opus: 'opus',
	'ac-3': 'ac3',
	'ec-3': 'eac3',
	fLaC: 'flac'
};

function u32(b: Uint8Array, o: number): number {
	return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
	return u32(b, o) * 2 ** 32 + u32(b, o + 4);
}

function i32(b: Uint8Array, o: number): number {
	return u32(b, o) | 0;
}

function fourcc(b: Uint8Array, o: number): string {
	return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

interface Box {
	type: string;
	/** Offset of the payload within the buffer it was read from. */
	start: number;
	end: number;
}

function children(b: Uint8Array, start: number, end: number): Box[] {
	const out: Box[] = [];
	let o = start;
	while (o + 8 <= end) {
		let size = u32(b, o);
		const type = fourcc(b, o + 4);
		let header = 8;
		if (size === 1) {
			if (o + 16 > end) break;
			size = u64(b, o + 8);
			header = 16;
		} else if (size === 0) {
			size = end - o;
		}
		if (size < header || o + size > end) break;
		out.push({ type, start: o + header, end: o + size });
		o += size;
	}
	return out;
}

function child(b: Uint8Array, box: Box, type: string): Box | undefined {
	return children(b, box.start, box.end).find((c) => c.type === type);
}

function path(b: Uint8Array, box: Box, ...types: string[]): Box | undefined {
	let current: Box | undefined = box;
	for (const type of types) {
		if (!current) return undefined;
		current = child(b, current, type);
	}
	return current;
}

/** Timescale and duration from an `mvhd` or `mdhd` payload. */
function timing(b: Uint8Array, box: Box): { timescale: number; duration: number } | null {
	const version = b[box.start];
	if (version === 1) {
		if (box.start + 32 > box.end) return null;
		return { timescale: u32(b, box.start + 20), duration: u64(b, box.start + 24) };
	}
	if (box.start + 20 > box.end) return null;
	return { timescale: u32(b, box.start + 12), duration: u32(b, box.start + 16) };
}

interface TrackFacts {
	kind: string;
	codec: string;
	width: number;
	height: number;
	durationMs: number;
	fps: number | null;
}

function readTrack(b: Uint8Array, trak: Box): TrackFacts | null {
	const hdlr = path(b, trak, 'mdia', 'hdlr');
	if (!hdlr || hdlr.start + 12 > hdlr.end) return null;
	const kind = fourcc(b, hdlr.start + 8);

	const stsd = path(b, trak, 'mdia', 'minf', 'stbl', 'stsd');
	const codec = stsd && stsd.start + 16 <= stsd.end ? fourcc(b, stsd.start + 12) : '';

	let width = 0;
	let height = 0;
	const tkhd = child(b, trak, 'tkhd');
	if (tkhd) {
		const version = b[tkhd.start];
		// version/flags, then times, track id and duration: 20 bytes in v0, 32 in v1.
		const matrix = tkhd.start + 4 + (version === 1 ? 32 : 20) + 16;
		if (matrix + 44 <= tkhd.end) {
			const a = i32(b, matrix);
			const bb = i32(b, matrix + 4);
			width = Math.round(u32(b, matrix + 36) / 65536);
			height = Math.round(u32(b, matrix + 40) / 65536);
			// A 90° or 270° rotation zeroes the diagonal: the picture is shown on its side.
			if (a === 0 && bb !== 0) [width, height] = [height, width];
		}
	}

	let durationMs = 0;
	let fps: number | null = null;
	const mdhd = path(b, trak, 'mdia', 'mdhd');
	const t = mdhd ? timing(b, mdhd) : null;
	if (t && t.timescale > 0) {
		durationMs = Math.round((t.duration / t.timescale) * 1000);
		const stts = path(b, trak, 'mdia', 'minf', 'stbl', 'stts');
		if (kind === 'vide' && stts && stts.start + 8 <= stts.end && t.duration > 0) {
			const count = u32(b, stts.start + 4);
			let samples = 0;
			for (let i = 0; i < count && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
				samples += u32(b, stts.start + 8 + i * 8);
			}
			if (samples > 0) fps = Math.round((samples / (t.duration / t.timescale)) * 100) / 100;
		}
	}
	return { kind, codec, width, height, durationMs, fps };
}

/** Facts from a whole `moov` payload. */
function readMoov(moov: Uint8Array): Omit<Mp4Facts, 'brand' | 'faststart'> | null {
	const root: Box = { type: 'moov', start: 0, end: moov.length };
	const tracks = children(moov, 0, moov.length)
		.filter((c) => c.type === 'trak')
		.map((trak) => readTrack(moov, trak))
		.filter((t): t is TrackFacts => t !== null);
	const video = tracks.find((t) => t.kind === 'vide');
	const audio = tracks.find((t) => t.kind === 'soun');
	const mvhd = child(moov, root, 'mvhd');
	const movie = mvhd ? timing(moov, mvhd) : null;
	let durationMs =
		movie && movie.timescale > 0 ? Math.round((movie.duration / movie.timescale) * 1000) : 0;
	// Fragmented files leave mvhd at zero; the longest track is the next best answer.
	if (!durationMs) durationMs = Math.max(0, ...tracks.map((t) => t.durationMs));
	return {
		durationMs,
		width: video?.width || null,
		height: video?.height || null,
		videoCodec: video ? (VIDEO_CODECS[video.codec] ?? (video.codec || null)) : null,
		audioCodec: audio ? (AUDIO_CODECS[audio.codec] ?? (audio.codec || null)) : null,
		fps: video?.fps ?? null
	};
}

/**
 * Probe a stored file. Null when it is not an ISO-BMFF file this can read: no
 * `ftyp` first, no `moov`, or a `moov` too large to be a real video's.
 */
export async function probeMp4(read: RangeReader, size: number): Promise<Mp4Facts | null> {
	let offset = 0;
	let brand = '';
	let moovAt = -1;
	let moovSize = 0;
	let moovHeader = 8;
	let mdatAt = -1;
	for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset + 8 <= size; i++) {
		const head = await read(offset, Math.min(offset + 15, size - 1));
		if (!head || head.length < 8) return null;
		let boxSize = u32(head, 0);
		const type = fourcc(head, 4);
		let header = 8;
		if (boxSize === 1) {
			if (head.length < 16) return null;
			boxSize = u64(head, 8);
			header = 16;
		} else if (boxSize === 0) {
			boxSize = size - offset;
		}
		if (boxSize < header || offset + boxSize > size) return null;
		if (i === 0) {
			if (type !== 'ftyp' || head.length < 12) return null;
			brand = fourcc(head, 8);
		}
		if (type === 'moov') {
			moovAt = offset;
			moovSize = boxSize;
			moovHeader = header;
		} else if (type === 'mdat' && mdatAt < 0) {
			mdatAt = offset;
		}
		if (moovAt >= 0 && mdatAt >= 0) break;
		offset += boxSize;
	}
	if (moovAt < 0 || moovSize - moovHeader > MAX_MOOV_BYTES) return null;
	const moov = await read(moovAt + moovHeader, moovAt + moovSize - 1);
	if (!moov) return null;
	const facts = readMoov(moov);
	if (!facts) return null;
	return { brand, ...facts, faststart: mdatAt < 0 || moovAt < mdatAt };
}

/** The same, for bytes already in memory. */
export function probeMp4Bytes(bytes: Uint8Array): Promise<Mp4Facts | null> {
	return probeMp4(async (start, end) => bytes.slice(start, end + 1), bytes.length);
}
