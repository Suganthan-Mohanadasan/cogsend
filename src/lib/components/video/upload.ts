/**
 * Sends a prepared video to a draft in parts (POST /api/drafts/:id/media/uploads),
 * so it is not held to the 100 MB a single request may carry. A part that
 * fails for a passing reason is sent again; cancelling aborts the upload on the
 * server too, so nothing is left half-stored.
 */

const PART_TRIES = 3;

interface UploadClaim {
	key: string;
	uploadId: string;
	size: number;
	segmentIndex: number;
	token: string;
	partSize: number;
	parts: number;
}

async function errorOf(res: Response, fallback: string): Promise<Error> {
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	return new Error(data.error || fallback);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new DOMException('Cancelled', 'AbortError'));
			},
			{ once: true }
		);
	});
}

async function sendPart(
	draftId: string,
	claim: UploadClaim,
	n: number,
	body: Blob,
	signal: AbortSignal
): Promise<{ partNumber: number; etag: string }> {
	const query = new URLSearchParams({
		key: claim.key,
		uploadId: claim.uploadId,
		size: String(claim.size),
		segmentIndex: String(claim.segmentIndex),
		token: claim.token,
		n: String(n)
	});
	for (let attempt = 1; ; attempt++) {
		let res: Response | null = null;
		try {
			res = await fetch(`/api/drafts/${draftId}/media/uploads/part?${query}`, {
				method: 'PUT',
				body,
				signal
			});
		} catch (err) {
			if (signal.aborted) throw err;
		}
		if (res?.ok) return (await res.json()) as { partNumber: number; etag: string };
		// A refusal (bad token, wrong length) will be refused again.
		if (res && res.status < 500 && res.status !== 429) {
			throw await errorOf(res, 'Upload failed');
		}
		if (attempt >= PART_TRIES) {
			throw res
				? await errorOf(res, 'Upload failed')
				: new Error('Upload failed — check your connection');
		}
		await wait(1000 * 2 ** (attempt - 1), signal);
	}
}

export async function uploadVideo<T>(
	draftId: string,
	opts: {
		file: Blob;
		segmentIndex: number;
		altText?: string | null;
		signal: AbortSignal;
		onProgress: (fraction: number) => void;
	}
): Promise<T> {
	const created = await fetch(`/api/drafts/${draftId}/media/uploads`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			size: opts.file.size,
			mime: 'video/mp4',
			segmentIndex: opts.segmentIndex
		}),
		signal: opts.signal
	});
	if (!created.ok) throw await errorOf(created, 'Upload failed');
	const claim = (await created.json()) as UploadClaim;
	const abort = () =>
		void fetch(`/api/drafts/${draftId}/media/uploads`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(claim),
			keepalive: true
		}).catch(() => {});
	try {
		const parts: { partNumber: number; etag: string }[] = [];
		for (let n = 1; n <= claim.parts; n++) {
			const start = (n - 1) * claim.partSize;
			const body = opts.file.slice(start, Math.min(opts.file.size, start + claim.partSize));
			parts.push(await sendPart(draftId, claim, n, body, opts.signal));
			opts.onProgress(n / claim.parts);
		}
		const done = await fetch(`/api/drafts/${draftId}/media/uploads/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...claim, parts, altText: opts.altText ?? null }),
			signal: opts.signal
		});
		if (!done.ok) throw await errorOf(done, 'Upload failed');
		return ((await done.json()) as { media: T }).media;
	} catch (err) {
		abort();
		throw err;
	}
}
