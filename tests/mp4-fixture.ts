/**
 * Small but real ISO-BMFF files for tests: the boxes the server probe reads
 * (ftyp, moov/mvhd, trak/tkhd, mdia/mdhd/hdlr, stbl/stsd/stts) and an mdat,
 * in either order.
 */
export interface Mp4Spec {
	durationMs?: number;
	width?: number;
	height?: number;
	/** Sample entry of the video track; null for an audio-only file. */
	video?: string | null;
	/** Sample entry of the audio track; null for none. */
	audio?: string | null;
	fps?: number;
	/** moov before mdat. */
	faststart?: boolean;
	/** Rotate 90° through the track matrix. */
	rotate90?: boolean;
	brand?: string;
	/** Bytes of media data, to make a file of a given size. */
	mdatBytes?: number;
}

function u32(n: number): number[] {
	return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function str(s: string): number[] {
	return [...s].map((c) => c.charCodeAt(0));
}

function box(type: string, ...payload: number[][]): number[] {
	const body = payload.flat();
	return [...u32(body.length + 8), ...str(type), ...body];
}

function fullBox(type: string, ...payload: number[][]): number[] {
	return box(type, [0, 0, 0, 0], ...payload);
}

const TIMESCALE = 1000;

function track(opts: {
	kind: 'vide' | 'soun';
	entry: string;
	durationMs: number;
	width: number;
	height: number;
	fps: number;
	rotate90: boolean;
}): number[] {
	const matrix = opts.rotate90
		? [0, 65536, 0, -65536, 0, 0, 0, 0, 0x40000000]
		: [65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000];
	const tkhd = fullBox(
		'tkhd',
		u32(0),
		u32(0),
		u32(opts.kind === 'vide' ? 1 : 2),
		u32(0),
		u32(opts.durationMs),
		u32(0),
		u32(0),
		[0, 0, 0, 0, 0, 0, 0, 0],
		matrix.flatMap((m) => u32(m >>> 0)),
		u32(opts.width * 65536),
		u32(opts.height * 65536)
	);
	const mdhd = fullBox('mdhd', u32(0), u32(0), u32(TIMESCALE), u32(opts.durationMs), u32(0));
	const hdlr = fullBox('hdlr', u32(0), str(opts.kind), u32(0), u32(0), u32(0), [0]);
	const stsd = fullBox('stsd', u32(1), box(opts.entry, new Array(8).fill(0)));
	const samples =
		opts.kind === 'vide' ? Math.max(1, Math.round((opts.durationMs / 1000) * opts.fps)) : 1;
	const delta = Math.max(1, Math.round(opts.durationMs / samples));
	const stts = fullBox('stts', u32(1), u32(samples), u32(delta));
	const stbl = box('stbl', stsd, stts);
	const minf = box('minf', stbl);
	const mdia = box('mdia', mdhd, hdlr, minf);
	return box('trak', tkhd, mdia);
}

export function buildMp4(spec: Mp4Spec = {}): Uint8Array<ArrayBuffer> {
	const durationMs = spec.durationMs ?? 10_000;
	const width = spec.width ?? 1280;
	const height = spec.height ?? 720;
	const fps = spec.fps ?? 30;
	const video = spec.video === undefined ? 'avc1' : spec.video;
	const audio = spec.audio === undefined ? 'mp4a' : spec.audio;
	const ftyp = box('ftyp', str(spec.brand ?? 'isom'), u32(512), str('isom'), str('mp42'));
	const mvhd = fullBox(
		'mvhd',
		u32(0),
		u32(0),
		u32(TIMESCALE),
		u32(durationMs),
		new Array(80).fill(0)
	);
	const traks: number[][] = [];
	const common = { durationMs, width, height, fps, rotate90: Boolean(spec.rotate90) };
	if (video) traks.push(track({ kind: 'vide', entry: video, ...common }));
	if (audio) traks.push(track({ kind: 'soun', entry: audio, ...common, width: 0, height: 0 }));
	const moov = new Uint8Array(box('moov', mvhd, ...traks));
	const head = new Uint8Array(ftyp);
	// The payload is built as a typed array: tests make files of tens of MB.
	const dataBytes = spec.mdatBytes ?? 64;
	const mdat = new Uint8Array(dataBytes + 8).fill(7);
	mdat.set([...u32(dataBytes + 8), ...str('mdat')], 0);
	const order = spec.faststart === false ? [head, mdat, moov] : [head, moov, mdat];
	const out = new Uint8Array(order.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of order) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
