import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingError } from '$lib/result';

const ASSEMBLYAI_TOKEN_URL = 'https://api.assemblyai.com/v2/realtime/token';
const ASSEMBLYAI_WS_URL = 'wss://api.assemblyai.com/v2/realtime/ws';
const TARGET_SAMPLE_RATE = 16000;

type StreamingSession = {
	socket: WebSocket;
	audioContext: AudioContext;
	processor: ScriptProcessorNode;
	source: MediaStreamAudioSourceNode;
	finalTranscriptParts: string[];
	pendingPartial: string;
	onPartial: (text: string) => void;
	terminated: boolean;
	sessionEnded: Promise<void>;
	resolveSessionEnded: () => void;
};

let activeSession: StreamingSession | null = null;

async function fetchTempToken(apiKey: string): Promise<string> {
	const res = await fetch(ASSEMBLYAI_TOKEN_URL, {
		method: 'POST',
		headers: {
			Authorization: apiKey,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ expires_in: 3600 }),
	});
	if (!res.ok) throw new Error(`AssemblyAI token request failed (${res.status}): ${await res.text()}`);
	const { token } = (await res.json()) as { token: string };
	return token;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
	const out = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		const s = Math.max(-1, Math.min(1, input[i] ?? 0));
		out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return out;
}

export const AssemblyAIStreamingServiceLive = {
	hasActiveSession(): boolean {
		return activeSession !== null && !activeSession.terminated;
	},

	/**
	 * Start a streaming session. Opens the AssemblyAI WebSocket, starts capturing
	 * audio from the provided MediaStream at 16kHz, and streams PCM16 frames.
	 * Partial transcripts fire onPartial; final segments accumulate internally.
	 */
	async startSession({
		apiKey,
		mediaStream,
		onPartial,
	}: {
		apiKey: string;
		mediaStream: MediaStream;
		onPartial: (text: string) => void;
	}): Promise<Result<void, WhisperingError>> {
		if (activeSession && !activeSession.terminated) {
			return WhisperingErr({
				title: 'Streaming session already active',
				description: 'A previous AssemblyAI session is still running.',
			});
		}

		const { data: token, error: tokenError } = await tryAsync({
			try: () => fetchTempToken(apiKey),
			catch: (error) =>
				WhisperingErr({
					title: '🔑 AssemblyAI auth failed',
					description:
						'Could not obtain a streaming token. Check your AssemblyAI API key in settings.',
					action: { type: 'more-details', error },
				}),
		});
		if (tokenError) return Err(tokenError);

		const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
		const source = audioContext.createMediaStreamSource(mediaStream);
		const processor = audioContext.createScriptProcessor(4096, 1, 1);

		const wsUrl = `${ASSEMBLYAI_WS_URL}?sample_rate=${TARGET_SAMPLE_RATE}&token=${encodeURIComponent(token)}`;
		const socket = new WebSocket(wsUrl);
		socket.binaryType = 'arraybuffer';

		let resolveSessionEnded!: () => void;
		const sessionEnded = new Promise<void>((r) => {
			resolveSessionEnded = r;
		});

		const session: StreamingSession = {
			socket,
			audioContext,
			processor,
			source,
			finalTranscriptParts: [],
			pendingPartial: '',
			onPartial,
			terminated: false,
			sessionEnded,
			resolveSessionEnded,
		};
		activeSession = session;

		socket.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data as string) as {
					message_type?: string;
					text?: string;
				};
				if (msg.message_type === 'PartialTranscript' && msg.text) {
					session.pendingPartial = msg.text;
					session.onPartial(
						[...session.finalTranscriptParts, session.pendingPartial]
							.filter(Boolean)
							.join(' '),
					);
				} else if (msg.message_type === 'FinalTranscript' && msg.text) {
					session.finalTranscriptParts.push(msg.text);
					session.pendingPartial = '';
					session.onPartial(session.finalTranscriptParts.join(' '));
				} else if (msg.message_type === 'SessionTerminated') {
					session.resolveSessionEnded();
				}
			} catch (e) {
				console.warn('[AssemblyAI] Failed to parse message', e);
			}
		};

		socket.onerror = (e) => console.error('[AssemblyAI] WS error', e);
		socket.onclose = () => {
			session.resolveSessionEnded();
		};

		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true });
			socket.addEventListener('error', (e) => reject(e), { once: true });
		});

		processor.onaudioprocess = (event) => {
			if (session.terminated || socket.readyState !== WebSocket.OPEN) return;
			const input = event.inputBuffer.getChannelData(0);
			const pcm16 = floatTo16BitPCM(input);
			socket.send(pcm16.buffer);
		};

		source.connect(processor);
		processor.connect(audioContext.destination);

		return Ok(undefined);
	},

	/**
	 * End the streaming session cleanly. Sends terminate_session, waits for the
	 * server to flush any final transcripts, then returns the full text.
	 */
	async finalizeSession(): Promise<Result<string, WhisperingError>> {
		const session = activeSession;
		if (!session || session.terminated) {
			return WhisperingErr({
				title: 'No active streaming session',
				description: 'Tried to finalize but no AssemblyAI session is running.',
			});
		}
		session.terminated = true;

		try {
			if (session.socket.readyState === WebSocket.OPEN) {
				session.socket.send(JSON.stringify({ terminate_session: true }));
				await Promise.race([
					session.sessionEnded,
					new Promise<void>((r) => setTimeout(r, 3000)),
				]);
			}
			session.socket.close();
		} catch (e) {
			console.warn('[AssemblyAI] Error during finalize', e);
		}

		try {
			session.processor.disconnect();
			session.source.disconnect();
			await session.audioContext.close();
		} catch (e) {
			console.warn('[AssemblyAI] Error closing AudioContext', e);
		}

		const finalText = [...session.finalTranscriptParts, session.pendingPartial]
			.filter(Boolean)
			.join(' ')
			.trim();

		activeSession = null;
		return Ok(finalText);
	},

	/**
	 * Cancel without waiting for final transcripts. For hotkey-cancel.
	 */
	async cancelSession(): Promise<void> {
		const session = activeSession;
		if (!session) return;
		session.terminated = true;
		try {
			session.socket.close();
			session.processor.disconnect();
			session.source.disconnect();
			await session.audioContext.close();
		} catch {
			// best-effort cleanup
		}
		activeSession = null;
	},
};

export type AssemblyAIStreamingService = typeof AssemblyAIStreamingServiceLive;
