/**
 * Reactive store for in-flight streaming transcripts. Updated by the AssemblyAI
 * streaming session on every Partial/FinalTranscript message, read by the
 * PartialTranscriptOverlay component so the user sees text appearing as they
 * speak.
 */
class PartialTranscriptStore {
	text = $state('');
	visible = $state(false);

	set(text: string) {
		this.text = text;
		this.visible = text.length > 0;
	}

	clear() {
		this.text = '';
		this.visible = false;
	}
}

export const partialTranscript = new PartialTranscriptStore();
