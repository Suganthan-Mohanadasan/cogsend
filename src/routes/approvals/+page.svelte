<script lang="ts">
	import { onMount } from 'svelte';
	type Choice = {
		id: string;
		title?: string | null;
		baseBody?: string;
		displayName?: string | null;
		handle?: string | null;
		platform?: string;
	};
	let drafts = $state<Choice[]>([]),
		connections = $state<Choice[]>([]);
	let draftId = $state(''),
		connectionId = $state(''),
		scheduledFor = $state('');
	let preview = $state<{ payload: unknown; hash: string } | null>(null),
		previewSelection = $state('');
	let message = $state(''),
		busy = $state(false),
		halted = $state(true),
		mode = $state('');
	let keys = $state<{ id: string; prefix: string; scopes: string[] }[]>([]),
		keyScope = $state('draft'),
		newKey = $state('');
	let audit = $state<
		{ id: string; event: string; actor: string; createdAt: string; detail: string }[]
	>([]);
	const selection = $derived(JSON.stringify([draftId, connectionId, scheduledFor]));
	const reviewed = $derived(preview !== null && selection === previewSelection);
	async function api(path: string, method = 'GET', body?: unknown) {
		const response = await fetch(path, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? 'Request failed');
		return data;
	}
	async function refresh() {
		try {
			const [d, c, p, k] = await Promise.all([
				api('/api/drafts'),
				api('/api/connections'),
				api('/api/publishing'),
				api('/api/key')
			]);
			drafts = d.drafts;
			connections = c.connections;
			halted = p.halted;
			mode = p.mode;
			audit = p.audit;
			keys = k.keys;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Could not load';
		}
	}
	onMount(() => {
		void refresh();
	});
	function time() {
		return scheduledFor ? new Date(scheduledFor).toISOString() : null;
	}
	async function review() {
		busy = true;
		message = '';
		preview = null;
		try {
			const query = new URLSearchParams({ connectionId });
			const when = time();
			if (when) query.set('scheduledFor', when);
			preview = await api(`/api/drafts/${draftId}/approval?${query}`);
			previewSelection = selection;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Review failed';
		} finally {
			busy = false;
		}
	}
	async function approve() {
		if (!reviewed || !preview) return;
		busy = true;
		try {
			await api(`/api/drafts/${draftId}/approval`, 'POST', {
				connectionId,
				scheduledFor: time(),
				hash: preview.hash
			});
			message = 'Approved. Publishing and scheduling remain separate actions.';
			await refresh();
		} catch (e) {
			message = e instanceof Error ? e.message : 'Approval failed';
		} finally {
			busy = false;
		}
	}
	async function schedule() {
		if (!reviewed || !scheduledFor) return;
		busy = true;
		try {
			await api(`/api/drafts/${draftId}/schedule`, 'POST', {
				connectionIds: [connectionId],
				runAt: time()
			});
			message = 'Approved post scheduled.';
			await refresh();
		} catch (e) {
			message = e instanceof Error ? e.message : 'Scheduling failed';
		} finally {
			busy = false;
		}
	}
	async function toggleHalt() {
		try {
			const p = await api('/api/publishing', 'PATCH', { halted: !halted });
			halted = p.halted;
			await refresh();
		} catch (e) {
			message = e instanceof Error ? e.message : 'Setting failed';
		}
	}
	async function createKey() {
		try {
			const k = await api('/api/key', 'POST', { scopes: [keyScope] });
			newKey = k.key;
			await refresh();
		} catch (e) {
			message = e instanceof Error ? e.message : 'Key creation failed';
		}
	}
	async function revoke(id: string) {
		try {
			await api(`/api/key?id=${encodeURIComponent(id)}`, 'DELETE');
			await refresh();
		} catch (e) {
			message = e instanceof Error ? e.message : 'Revocation failed';
		}
	}
</script>

<svelte:head><title>Publishing approvals · CogSend</title></svelte:head>
<div class="mx-auto max-w-3xl space-y-6 p-6">
	<h1 class="text-2xl font-semibold">Publishing approvals</h1>
	<p>
		Review one destination and its exact publishing time. Any content edit requires a new approval.
	</p>
	<section class="space-y-3 rounded-lg border p-4">
		<h2 class="text-lg font-semibold">Publishing is {halted ? 'halted' : 'enabled'}</h2>
		<p>
			Mode: {mode}. A stop blocks the next outbound call; a request already sent cannot be recalled.
		</p>
		<button class="rounded border px-4 py-2" onclick={toggleHalt}
			>{halted ? 'Enable publishing' : 'Halt all publishing'}</button
		>
	</section>
	<section class="space-y-3 rounded-lg border p-4">
		<label class="block" for="approval-draft">Draft</label>
		<select id="approval-draft" class="block w-full rounded border p-2" bind:value={draftId}>
			<option value="">Choose a draft</option>
			{#each drafts as draft (draft.id)}
				<option value={draft.id}>{draft.title || draft.baseBody?.slice(0, 80) || draft.id}</option>
			{/each}
		</select>
		<label class="block" for="approval-destination">Destination</label>
		<select
			id="approval-destination"
			class="block w-full rounded border p-2"
			bind:value={connectionId}
		>
			<option value="">Choose an account</option>
			{#each connections as connection (connection.id)}
				<option value={connection.id}
					>{connection.platform} · {connection.displayName ||
						connection.handle ||
						connection.id}</option
				>
			{/each}
		</select>
		<label class="block"
			>Scheduled time (your local time; leave blank for Publish now) <input
				class="block rounded border p-2"
				type="datetime-local"
				bind:value={scheduledFor}
			/></label
		>
		<button
			class="rounded border px-4 py-2"
			disabled={busy || !draftId || !connectionId}
			onclick={review}>Review final payload</button
		>
		{#if reviewed && preview}
			<pre
				class="overflow-auto rounded bg-stone-100 p-4 text-sm whitespace-pre-wrap">{JSON.stringify(
					preview.payload,
					null,
					2
				)}</pre>
			<p class="text-xs break-all">SHA-256: {preview.hash}</p>
			<button class="rounded border px-4 py-2" disabled={busy} onclick={approve}
				>Approve this exact payload</button
			>
			{#if scheduledFor}<button class="rounded border px-4 py-2" disabled={busy} onclick={schedule}
					>Schedule approved post</button
				>{/if}
		{/if}
	</section>
	{#if message}<p role="status">{message}</p>{/if}
	<section class="space-y-3 rounded-lg border p-4">
		<h2 class="text-lg font-semibold">Scoped API keys</h2>
		<p>
			Draft keys can prepare content and read status. Approval keys can approve a reviewed hash and
			send or schedule approved content. Keys cannot manage other keys or the kill switch.
		</p>
		<label
			>New key scope <select class="rounded border p-2" bind:value={keyScope}
				><option value="draft">Draft</option><option value="approve_schedule"
					>Approve and schedule</option
				><option value="read">Read only</option></select
			></label
		>
		<button class="rounded border px-4 py-2" onclick={createKey}>Create key</button>
		{#if newKey}<p>Copy this key now. It is shown only once.</p>
			<code class="block break-all">{newKey}</code><button onclick={() => (newKey = '')}
				>Hide key</button
			>{/if}
		{#each keys as key (key.id)}<div class="flex items-center justify-between gap-3">
				<span>{key.prefix}… ({key.scopes.join(', ')})</span><button
					class="rounded border px-3 py-1"
					onclick={() => revoke(key.id)}>Revoke</button
				>
			</div>{/each}
	</section>
	<section class="space-y-3">
		<h2 class="text-lg font-semibold">Recent audit events</h2>
		{#each audit as entry (entry.id)}<details class="rounded border p-3">
				<summary>{entry.createdAt} · {entry.event} · {entry.actor}</summary>
				<pre class="overflow-auto text-sm whitespace-pre-wrap">{entry.detail}</pre>
			</details>{/each}
	</section>
</div>
