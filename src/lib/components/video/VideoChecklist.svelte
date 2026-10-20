<script lang="ts">
	import { Check, TriangleAlert, X } from '@lucide/svelte';
	import { platformName } from '#lib/domain/platforms.js';
	import {
		videoIssues,
		type VideoFacts,
		type VideoIssue,
		type VideoRuleMeta
	} from '#lib/domain/video-rules.js';

	let {
		facts,
		accounts,
		testId
	}: {
		facts: VideoFacts;
		/** The selected accounts; each is checked with its own limits. */
		accounts: { platform: string; meta: VideoRuleMeta | null }[];
		testId: string;
	} = $props();

	// One chip per platform. Two accounts on one platform can differ (X Premium
	// and a free account), so the strictest answer wins.
	const rows = $derived.by(() => {
		const byPlatform = new Map<string, VideoIssue[]>();
		for (const account of accounts) {
			const issues = videoIssues(account.platform, facts, account.meta);
			const seen = byPlatform.get(account.platform);
			const worse = (list: VideoIssue[]) =>
				list.filter((i) => i.level === 'error').length * 100 + list.length;
			if (!seen || worse(issues) > worse(seen)) byPlatform.set(account.platform, issues);
		}
		return [...byPlatform].map(([platform, issues]) => ({
			platform,
			name: platformName(platform),
			level: issues.some((i) => i.level === 'error')
				? ('error' as const)
				: issues.length
					? ('warn' as const)
					: ('ok' as const),
			messages: issues.map((i) => i.message)
		}));
	});
	const firstProblem = $derived(
		rows.find((r) => r.level === 'error')?.messages[0] ??
			rows.find((r) => r.level === 'warn')?.messages[0] ??
			null
	);
</script>

{#if rows.length}
	<div class="mt-2" data-testid={testId}>
		<ul class="flex flex-wrap gap-1.5" aria-label="How each platform takes this video">
			{#each rows as row (row.platform)}
				<li
					data-testid="{testId}-{row.platform}"
					data-level={row.level}
					title={row.messages.join('\n') || `${row.name} takes this video`}
					class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold {row.level ===
					'error'
						? 'border-red-200 bg-red-50 text-red-700'
						: row.level === 'warn'
							? 'border-amber-200 bg-amber-50 text-amber-800'
							: 'border-stone-200 bg-stone-50 text-stone-700'}"
				>
					{#if row.level === 'error'}
						<X class="h-3 w-3" aria-hidden="true" />
					{:else if row.level === 'warn'}
						<TriangleAlert class="h-3 w-3" aria-hidden="true" />
					{:else}
						<Check class="h-3 w-3" aria-hidden="true" />
					{/if}
					{row.name}
					<span class="sr-only">
						{row.level === 'ok' ? 'takes this video' : row.messages.join('. ')}
					</span>
				</li>
			{/each}
		</ul>
		{#if firstProblem}
			<p class="mt-1 text-[11px] font-medium text-stone-600" aria-hidden="true">{firstProblem}</p>
		{/if}
	</div>
{/if}
