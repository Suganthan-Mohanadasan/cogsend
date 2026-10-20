<script lang="ts">
	import { Check, TriangleAlert, X } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { dismissToast, toast } from './toast.svelte.js';
</script>

<!-- The live region repeats the toast's wording, so it has its own test id: a
     `getByText` for a publish message matches both once the announcement
     lands (30 ms later), which is a strict-mode violation rather than a
     passing assertion. -->
<div class="sr-only" role="status" aria-live="polite" data-testid="publish-announcement">
	{toast.announcement}
</div>
{#if toast.message}
	{@const tone = toast.tone}
	<div
		class="pointer-events-none fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-stone-200/80 bg-white/95 px-4 py-2.5 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
		transition:fly={{ y: 20, duration: 300, opacity: 0 }}
		role={tone === 'error' ? 'alert' : 'status'}
		data-testid="publish-toast"
	>
		<div
			class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white {tone ===
			'success'
				? 'bg-emerald-500'
				: tone === 'warn'
					? 'bg-amber-500'
					: 'bg-red-500'}"
		>
			{#if tone === 'success'}
				<Check class="h-3.5 w-3.5" strokeWidth={3} />
			{:else if tone === 'warn'}
				<TriangleAlert class="h-3.5 w-3.5" strokeWidth={2.5} />
			{:else}
				<X class="h-3.5 w-3.5" strokeWidth={3} />
			{/if}
		</div>
		<span
			class="max-w-64 truncate text-[13px] font-bold tracking-tight text-stone-700 sm:max-w-96"
			title={toast.message}>{toast.message}</span
		>
		{#if toast.action}
			<!-- Followed, it has done its job; an error would otherwise stick on the page it led to. -->
			<a
				href={toast.action.href}
				data-testid="toast-action"
				onclick={dismissToast}
				class="pointer-events-auto shrink-0 rounded-full bg-stone-900 px-3 py-1 text-[12px] font-bold text-white transition-colors hover:bg-stone-700"
			>
				{toast.action.label}
			</a>
		{/if}
		{#if tone === 'error'}
			<button
				type="button"
				data-testid="toast-dismiss"
				onclick={dismissToast}
				aria-label="Dismiss error"
				class="pointer-events-auto -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
			>
				<X class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>
{/if}
