<script lang="ts">
	import { dialogFocus } from '#lib/components/dialog-focus.js';
	import { drawFrame } from './prepare';

	let {
		open,
		src,
		atMs = null,
		hasCover,
		busy = false,
		onSave,
		onRemove,
		onClose
	}: {
		open: boolean;
		src: string;
		/** Where the current cover was taken, to start the slider there. */
		atMs?: number | null;
		hasCover: boolean;
		busy?: boolean;
		onSave: (jpeg: Blob, atMs: number | null) => void;
		onRemove: () => void;
		onClose: () => void;
	} = $props();

	let videoEl: HTMLVideoElement | null = $state(null);
	let fileInput: HTMLInputElement | null = $state(null);
	let duration = $state(0);
	let at = $state(0);
	let problem = $state<string | null>(null);

	function seek(seconds: number) {
		at = seconds;
		if (videoEl) videoEl.currentTime = seconds;
	}

	async function useFrame() {
		if (!videoEl) return;
		const jpeg = await drawFrame(videoEl);
		if (!jpeg) {
			problem = 'Could not take that frame — try another moment';
			return;
		}
		onSave(jpeg, Math.round(at * 1000));
	}

	// Any image becomes a JPEG at most 1280 wide: the server takes JPEG only.
	async function useImage(file: File) {
		problem = null;
		try {
			const bitmap = await createImageBitmap(file);
			const scale = Math.min(1, 1280 / bitmap.width);
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(bitmap.width * scale);
			canvas.height = Math.round(bitmap.height * scale);
			canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const jpeg = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, 'image/jpeg', 0.85)
			);
			if (!jpeg) throw new Error('encode');
			onSave(jpeg, null);
		} catch {
			problem = 'That image could not be read — try a JPEG or PNG';
		}
	}
</script>

{#if open}
	<div
		role="presentation"
		class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget && !busy) onClose();
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="video-cover-title"
			data-testid="video-cover-dialog"
			class="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[1.5rem] border border-stone-200/80 bg-white/95 p-5 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
			use:dialogFocus={{ onEscape: () => !busy && onClose() }}
		>
			<h2 id="video-cover-title" class="text-sm font-semibold">Cover</h2>
			<p class="mt-1 text-xs text-[var(--muted)]">
				Shown before the video plays on Mastodon and LinkedIn. X, Threads and Bluesky choose their
				own frame.
			</p>
			<video
				bind:this={videoEl}
				{src}
				muted
				playsinline
				preload="auto"
				class="mt-3 aspect-video w-full rounded-xl bg-black object-contain"
				onloadedmetadata={() => {
					duration = videoEl?.duration || 0;
					seek(Math.min((atMs ?? 1000) / 1000, Math.max(0, duration - 0.05)));
				}}
			></video>
			<label class="mt-3 block text-xs font-bold text-stone-700" for="video-cover-at">
				Frame
			</label>
			<input
				id="video-cover-at"
				type="range"
				min="0"
				max={Math.max(0, duration - 0.05)}
				step="0.05"
				value={at}
				disabled={!duration || busy}
				oninput={(e) => seek(Number(e.currentTarget.value))}
				data-testid="video-cover-slider"
				class="w-full"
			/>
			{#if problem}
				<p class="mt-2 text-xs font-medium text-red-700" role="alert">{problem}</p>
			{/if}
			<input
				bind:this={fileInput}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				class="hidden"
				onchange={(e) => {
					const file = e.currentTarget.files?.[0];
					e.currentTarget.value = '';
					if (file) void useImage(file);
				}}
			/>
			<div class="mt-4 flex flex-wrap items-center justify-between gap-2">
				<div class="flex gap-2">
					<button
						type="button"
						onclick={() => fileInput?.click()}
						disabled={busy}
						class="rounded-full border border-stone-200 px-3 py-1.5 text-xs font-bold text-stone-700 hover:border-stone-300 disabled:opacity-50"
					>
						Upload image
					</button>
					{#if hasCover}
						<button
							type="button"
							onclick={onRemove}
							disabled={busy}
							data-testid="video-cover-remove"
							class="rounded-full px-3 py-1.5 text-xs font-bold text-stone-500 hover:text-stone-900 disabled:opacity-50"
						>
							Remove
						</button>
					{/if}
				</div>
				<div class="flex gap-2">
					<button
						type="button"
						onclick={onClose}
						disabled={busy}
						class="rounded-full border border-stone-200 px-4 py-1.5 text-sm font-bold text-stone-500 hover:border-stone-300 hover:text-stone-900 disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={() => void useFrame()}
						disabled={!duration || busy}
						data-testid="video-cover-save"
						class="rounded-full bg-stone-900 px-4 py-1.5 text-sm font-bold text-white hover:bg-stone-800 disabled:opacity-50"
					>
						{busy ? 'Saving…' : 'Use this frame'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
