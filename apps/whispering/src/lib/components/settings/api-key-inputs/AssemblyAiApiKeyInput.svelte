<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { deviceConfig } from '$lib/state/device-config.svelte';
</script>

<Field.Field>
	<Field.Label for="assemblyai-api-key">AssemblyAI API Key</Field.Label>
	<Input
		id="assemblyai-api-key"
		type="password"
		placeholder="Your AssemblyAI API Key"
		autocomplete="off"
		bind:value={() => deviceConfig.get('apiKeys.assemblyai'),
			(value) => deviceConfig.set('apiKeys.assemblyai', value)}
	/>
	<Field.Description>
		You can find your API key in your <Link
			href="https://www.assemblyai.com/app/account"
			target="_blank"
			rel="noopener noreferrer"
		>
			AssemblyAI Dashboard
		</Link>
		. Streaming transcription requires a paid plan with credits.
	</Field.Description>
</Field.Field>
