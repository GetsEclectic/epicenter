<script lang="ts">
	import { partialTranscript } from '$lib/state/partial-transcript.svelte';
</script>

{#if partialTranscript.visible}
	<div
		class="pointer-events-none fixed bottom-24 left-1/2 z-50 max-w-[min(720px,90vw)] -translate-x-1/2 rounded-lg bg-black/80 px-5 py-3 text-base text-white shadow-lg backdrop-blur-sm"
		role="status"
		aria-live="polite"
	>
		{partialTranscript.text}
	</div>
{/if}
