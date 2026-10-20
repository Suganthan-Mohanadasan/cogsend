<script lang="ts">
	import { TriangleAlert } from '@lucide/svelte';
	import { platformName } from '#lib/domain/platforms.js';

	let {
		problems,
		onUncheck,
		testId
	}: {
		/** One row per platform that would refuse or alter what is attached. */
		problems: { platform: string; level: 'error' | 'warn'; message: string }[];
		/** Untick that platform's accounts; absent when the post cannot be edited. */
		onUncheck?: (platform: string) => void;
		testId: string;
	} = $props();
</script>

{#if problems.length}
	<ul class="mt-2 space-y-1" data-testid={testId}>
		{#each problems as row (row.platform)}
			<li
				data-testid="{testId}-{row.platform}"
				data-level={row.level}
				class="flex items-start gap-1.5 text-[12px] font-medium {row.level === 'error'
					? 'text-red-700'
					: 'text-stone-600'}"
			>
				<TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="min-w-0">
					{row.message}
					{#if onUncheck}
						·
						<button
							type="button"
							class="font-bold underline-offset-2 hover:underline"
							onclick={() => onUncheck(row.platform)}
						>
							Uncheck {platformName(row.platform)}
						</button>
					{/if}
				</span>
			</li>
		{/each}
	</ul>
{/if}
