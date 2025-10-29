import type { AvatarInteraction, UserAvatarStore } from '../userAvatar/index';

type GenericSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort?: () => void;
  onresult: ((event: any) => void) | null;
  onend: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
};

type GenericSpeechRecognitionConstructor = new () => GenericSpeechRecognition;

type SubmitPromptFn = (input: string, options?: { annotateLog?: boolean }) => Promise<{
  success: boolean;
  tokens: string[];
  kind: 'prompt' | 'command';
  error?: unknown;
}>;

type VoiceModelDockController = {
  focus(): void;
};

interface VoiceModelOptions {
  submitPrompt: SubmitPromptFn;
  userAvatar: UserAvatarStore;
  onTokensCommitted?: (tokens: string[], context?: { prompt?: string; kind?: 'prompt' | 'command' }) => void;
}

interface VoiceModelSettings {
  latency: number;
  fftSensitivity: number;
}

type CaptureSegment = {
  text: string;
  startMs: number;
  endMs: number;
};

type CapturedAudioPayload = {
  blob: Blob;
  mimeType: string;
  segments: CaptureSegment[];
  transcriptParts: string[];
  capturedAt: string;
  originalTranscript: string;
};

type TokenAudioClip = {
  token: string;
  transcript: string;
  blob: Blob;
};

const SETTINGS_STORAGE_KEY = 'hlsf-voice-model-settings';

function readSettings(): VoiceModelSettings {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return { latency: 120, fftSensitivity: 0.45 };
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { latency: 120, fftSensitivity: 0.45 };
    const parsed = JSON.parse(raw);
    const latency = Number.isFinite(parsed?.latency) ? Number(parsed.latency) : 120;
    const fftSensitivity = Number.isFinite(parsed?.fftSensitivity) ? Number(parsed.fftSensitivity) : 0.45;
    return {
      latency: Math.max(0, Math.round(latency)),
      fftSensitivity: Math.min(1, Math.max(0, Number(fftSensitivity))),
    };
  } catch {
    return { latency: 120, fftSensitivity: 0.45 };
  }
}

function writeSettings(settings: VoiceModelSettings): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('Unable to persist voice model settings:', error);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '—';
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: '2-digit',
    });
    return formatter.format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function describeStatus(entry: AvatarInteraction): string {
  switch (entry.status) {
    case 'processing':
      return 'Blooming adjacency maps…';
    case 'completed':
      return 'Adjacency bloom complete';
    case 'failed':
      return 'Processing failed';
    default:
      return 'Queued';
  }
}

function speakText(text: string): void {
  if (!text) return;
  if (typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined') return;
  const synthesis = window.speechSynthesis;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.05;
    synthesis.cancel();
    synthesis.speak(utterance);
  } catch (error) {
    console.warn('Voice playback failed:', error);
  }
}

type LocalVoiceOutputs = {
  prompt?: string;
  localThought?: string;
  localResponse?: string;
  updatedAt?: number;
  source?: string;
};

function getLatestLocalVoiceOutputs(): LocalVoiceOutputs | null {
  if (typeof window === 'undefined') return null;
  const root = (window as any).CognitionEngine;
  if (!root || typeof root !== 'object') return null;
  const voice = root.voice;
  if (!voice || typeof voice !== 'object') return null;

  try {
    if (typeof voice.getLatestLocalOutputs === 'function') {
      const value = voice.getLatestLocalOutputs();
      if (value && typeof value === 'object') {
        return value as LocalVoiceOutputs;
      }
    }
  } catch (error) {
    console.warn('Voice output retrieval failed:', error);
  }

  if (voice.latestLocalOutputs && typeof voice.latestLocalOutputs === 'object') {
    return voice.latestLocalOutputs as LocalVoiceOutputs;
  }

  return null;
}

function resolveLocalPlaybackText(): string {
  const data = getLatestLocalVoiceOutputs();
  if (!data) return '';
  const localResponse = typeof data.localResponse === 'string' ? data.localResponse.trim() : '';
  if (localResponse) return localResponse;
  const localThought = typeof data.localThought === 'string' ? data.localThought.trim() : '';
  return localThought;
}

export function initializeVoiceModelDock(options: VoiceModelOptions): VoiceModelDockController | null {
  if (!options || typeof options.submitPrompt !== 'function' || !options.userAvatar) {
    console.warn('Voice model dock requires submitPrompt and userAvatar options.');
    return null;
  }

  const root = document.getElementById('voice-model-window');
  if (!root) return null;

  const orb = root.querySelector<HTMLElement>('#voice-model-orb');
  const micButton = root.querySelector<HTMLButtonElement>('#voice-model-mic');
  const speakerButton = root.querySelector<HTMLButtonElement>('#voice-model-speaker');
  const promptInput = document.getElementById('command-input') as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  const statusEl = root.querySelector<HTMLElement>('#voice-model-status');
  const transcriptContainer = root.querySelector<HTMLElement>('#voice-model-transcript');
  const transcriptTokens = root.querySelector<HTMLElement>('#voice-model-transcript-tokens');
  const transcriptInterim = root.querySelector<HTMLElement>('#voice-model-transcript-interim');
  const transcriptPlaceholder = root.querySelector<HTMLElement>('#voice-model-transcript-placeholder');
  const transcriptActions = root.querySelector<HTMLElement>('#voice-model-transcript-actions');
  const transcriptSendCapturedButton = root.querySelector<HTMLButtonElement>('#voice-model-transcript-send');
  const transcriptEditorContainer = root.querySelector<HTMLElement>('#voice-model-editor');
  const transcriptEditor = root.querySelector<HTMLTextAreaElement>('#voice-model-editor-input');
  const transcriptSendButton = root.querySelector<HTMLButtonElement>('#voice-model-editor-send');
  const transcriptClearButton = root.querySelector<HTMLButtonElement>('#voice-model-editor-clear');
  const loadingEl = root.querySelector<HTMLElement>('#voice-model-loading');
  const loadingProgress = root.querySelector<HTMLElement>('#voice-model-loading-progress');
  const loadingLabel = root.querySelector<HTMLElement>('#voice-model-loading-label');
  const latencyInput = root.querySelector<HTMLInputElement>('#voice-model-latency');
  const fftInput = root.querySelector<HTMLInputElement>('#voice-model-fft');
  const logContainer = root.querySelector<HTMLElement>('#voice-model-log');
  const metricsContainer = root.querySelector<HTMLElement>('#voice-avatar-metrics');

  let listeningRequested = false;
  let recognition: GenericSpeechRecognition | null = null;
  let recognitionActive = false;
  let transcriptParts: string[] = [];
  let interimTranscript = '';
  let previousTokenCount = 0;
  let capturedTranscript = '';
  let audioStream: MediaStream | null = null;
  let audioRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let audioCaptureStartTime: number | null = null;
  let audioCaptureStartedAt: string | null = null;
  let currentAudioSegments: CaptureSegment[] = [];
  let capturedAudioPayload: CapturedAudioPayload | null = null;
  const RECOGNITION_SEGMENT_LAG_MS = 140;
  const MIN_SEGMENT_DURATION_MS = 120;
  const SEGMENT_PRE_ROLL_SEC = 0.04;
  const SEGMENT_POST_ROLL_SEC = 0.08;
  const MIN_TOKEN_DURATION_SEC = 0.12;
  let resumeListeningAfterSend = false;
  let loadingTimer: number | null = null;
  let lastPlaybackText = '';
  let settings = readSettings();
  let currentInteractionId: string | null = null;
  let inFlight = false;
  let promptInputPreviousValue: string | null = null;
  let promptInputPopulatedByVoice = false;

  if (latencyInput) {
    latencyInput.value = String(settings.latency);
  }
  if (fftInput) {
    fftInput.value = String(settings.fftSensitivity);
  }

  function updateStatus(message: string): void {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function updateOrbActive(active: boolean): void {
    if (!orb) return;
    orb.classList.toggle('is-active', active);
  }

  function getSpeechRecognitionConstructor(): GenericSpeechRecognitionConstructor | null {
    if (typeof window === 'undefined') return null;
    const global = window as unknown as {
      SpeechRecognition?: GenericSpeechRecognitionConstructor;
      webkitSpeechRecognition?: GenericSpeechRecognitionConstructor;
    };
    return global.SpeechRecognition || global.webkitSpeechRecognition || null;
  }

  const defaultTranscriptSendLabel = transcriptSendCapturedButton?.textContent?.trim() || 'Send captured prompt';

  function updateTranscriptSendButtonState(tokenCount?: number): void {
    if (!transcriptSendCapturedButton) return;
    const normalized = capturedTranscript.trim();
    const count =
      typeof tokenCount === 'number'
        ? tokenCount
        : normalized
            .split(/\s+/)
            .filter(Boolean)
            .length;
    const hasTranscript = normalized.length > 0 && count >= 0;

    if (count > 0) {
      transcriptSendCapturedButton.textContent =
        count === 1
          ? 'Send captured prompt (1 token)'
          : `Send captured prompt (${count} tokens)`;
    } else {
      transcriptSendCapturedButton.textContent = defaultTranscriptSendLabel;
    }

    transcriptSendCapturedButton.hidden = !hasTranscript;
    transcriptSendCapturedButton.disabled = !hasTranscript || inFlight;

    if (hasTranscript) {
      const label =
        count > 0 ? `Send captured prompt with ${count} ${count === 1 ? 'token' : 'tokens'}` : 'Send captured prompt';
      transcriptSendCapturedButton.setAttribute('aria-label', label);
    } else {
      transcriptSendCapturedButton.removeAttribute('aria-label');
    }

    if (transcriptActions) {
      transcriptActions.hidden = !hasTranscript;
    }
  }

  function updateMicButtonState(): void {
    if (!micButton) return;
    const ctor = getSpeechRecognitionConstructor();
    if (!ctor) {
      micButton.disabled = true;
      micButton.textContent = 'Speech recognition unavailable';
      micButton.removeAttribute('aria-pressed');
      return;
    }
    micButton.disabled = inFlight;
    micButton.textContent = listeningRequested ? 'Stop listening' : 'Start listening';
    micButton.setAttribute('aria-pressed', listeningRequested ? 'true' : 'false');
    updateEditorState();
    updateTranscriptSendButtonState();
  }

  function updateEditorState(): void {
    if (!transcriptEditor || !transcriptSendButton) return;
    const value = transcriptEditor.value ?? '';
    const hasContent = value.trim().length > 0;
    transcriptSendButton.disabled = !hasContent || inFlight;
    if (transcriptClearButton) {
      transcriptClearButton.disabled = value.length === 0 || inFlight;
    }
  }

  function hideTranscriptEditor(): void {
    if (transcriptEditor) {
      transcriptEditor.value = '';
    }
    if (transcriptEditorContainer) {
      transcriptEditorContainer.hidden = true;
    }
    updateEditorState();
  }

  function showTranscriptEditor(transcript: string): void {
    if (transcriptEditorContainer) {
      transcriptEditorContainer.hidden = false;
    }
    if (transcriptEditor) {
      transcriptEditor.value = transcript;
      if (typeof transcriptEditor.focus === 'function') {
        transcriptEditor.focus();
      }
    }
    updateTranscriptTokens(transcript, '');
    updateEditorState();
  }

  function updateTranscriptTokens(finalText: string, interimText: string): void {
    const normalizedFinal = typeof finalText === 'string' ? finalText.trim() : '';
    const tokens = normalizedFinal ? normalizedFinal.split(/\s+/).filter(Boolean) : [];
    capturedTranscript = normalizedFinal;
    if (transcriptTokens) {
      if (tokens.length) {
        const fragment = document.createDocumentFragment();
        const previousCount = previousTokenCount;
        tokens.forEach((token, index) => {
          const span = document.createElement('span');
          span.className = 'voice-model-token';
          if (index >= previousCount) {
            span.classList.add('voice-model-token--new');
            if (typeof window !== 'undefined') {
              window.setTimeout(() => span.classList.remove('voice-model-token--new'), 600);
            } else {
              span.classList.remove('voice-model-token--new');
            }
          }
          span.textContent = token;
          fragment.appendChild(span);
        });
        transcriptTokens.innerHTML = '';
        transcriptTokens.appendChild(fragment);
      } else {
        transcriptTokens.innerHTML = '';
      }
    }
    if (transcriptPlaceholder) {
      transcriptPlaceholder.classList.toggle('is-hidden', tokens.length > 0 || Boolean(interimText));
    }
    if (transcriptInterim) {
      transcriptInterim.textContent = interimText;
      transcriptInterim.classList.toggle('is-visible', Boolean(interimText));
    }
    if (transcriptContainer) {
      transcriptContainer.classList.toggle('voice-model-transcript--active', tokens.length > 0 || Boolean(interimText));
    }
    previousTokenCount = tokens.length;
    updateTranscriptSendButtonState(tokens.length);
  }

  function resetAudioCaptureState(): void {
    audioChunks = [];
    currentAudioSegments = [];
    audioCaptureStartTime = null;
    audioCaptureStartedAt = null;
  }

  function clearCapturedAudio(): void {
    capturedAudioPayload = null;
  }

  async function startAudioCapture(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (typeof window.MediaRecorder === 'undefined') {
      clearCapturedAudio();
      resetAudioCaptureState();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      clearCapturedAudio();
      resetAudioCaptureState();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStream = stream;
      audioRecorder = new MediaRecorder(stream);
      audioChunks = [];
      currentAudioSegments = [];
      capturedAudioPayload = null;
      audioCaptureStartTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      audioCaptureStartedAt = new Date().toISOString();
      audioRecorder.addEventListener('dataavailable', event => {
        if (event.data?.size) {
          audioChunks.push(event.data);
        }
      });
      audioRecorder.addEventListener('error', event => {
        console.warn('Voice model audio capture error:', event);
      });
      try {
        audioRecorder.start();
      } catch (error) {
        console.warn('Unable to start voice model audio recorder:', error);
        resetAudioCaptureState();
        clearCapturedAudio();
      }
    } catch (error) {
      console.warn('Unable to access microphone for voice model audio capture:', error);
      clearCapturedAudio();
      resetAudioCaptureState();
    }
  }

  function stopAudioCapture(): Promise<{ blob: Blob | null; mimeType: string }> {
    if (!audioRecorder) {
      if (audioStream) {
        try {
          audioStream.getTracks().forEach(track => track.stop());
        } catch {}
        audioStream = null;
      }
      return Promise.resolve({ blob: null, mimeType: '' });
    }

    const recorder = audioRecorder;
    audioRecorder = null;
    return new Promise(resolve => {
      recorder.addEventListener(
        'stop',
        () => {
          const mimeType = recorder.mimeType || 'audio/webm';
          const blob = audioChunks.length ? new Blob(audioChunks, { type: mimeType }) : null;
          audioChunks = [];
          if (audioStream) {
            try {
              audioStream.getTracks().forEach(track => track.stop());
            } catch {}
            audioStream = null;
          }
          resolve({ blob, mimeType });
        },
        { once: true },
      );
      try {
        recorder.stop();
      } catch (error) {
        console.warn('Failed to stop voice model audio recorder:', error);
        audioChunks = [];
        if (audioStream) {
          try {
            audioStream.getTracks().forEach(track => track.stop());
          } catch {}
          audioStream = null;
        }
        resolve({ blob: null, mimeType: '' });
      }
    }).finally(() => {
      resetAudioCaptureState();
    });
  }

  function noteAudioSegment(text: string): void {
    if (!text || !audioCaptureStartTime) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = Math.max(0, now - audioCaptureStartTime);
    const adjustedEnd = Math.max(0, elapsed - RECOGNITION_SEGMENT_LAG_MS);
    const last = currentAudioSegments[currentAudioSegments.length - 1];
    const startMs = last ? last.endMs : 0;
    const endMs = Math.max(startMs + MIN_SEGMENT_DURATION_MS, adjustedEnd);
    currentAudioSegments.push({ text, startMs, endMs });
  }

  async function commitCapturedAudioRecordings(
    tokens: string[],
    context: { prompt?: string; kind?: 'prompt' | 'command' },
  ): Promise<void> {
    if (!capturedAudioPayload || !tokens.length) {
      clearCapturedAudio();
      return;
    }
    if (typeof window === 'undefined') {
      clearCapturedAudio();
      return;
    }
    const voiceApi = (window as any)?.CognitionEngine?.voice;
    if (!voiceApi || typeof voiceApi.saveTokenRecordings !== 'function') {
      clearCapturedAudio();
      return;
    }

    try {
      const clips = await generateTokenRecordingsFromCapture(tokens, capturedAudioPayload, {
        preRoll: SEGMENT_PRE_ROLL_SEC,
        postRoll: SEGMENT_POST_ROLL_SEC,
        minimumTokenDuration: MIN_TOKEN_DURATION_SEC,
      });
      if (!clips.length) {
        clearCapturedAudio();
        return;
      }
      const payload = [] as Array<{
        token: string;
        transcript: string;
        audioBase64: string;
        audioType: string;
        capturedAt: string;
      }>;
      for (const clip of clips) {
        const base64 = await blobToBase64(clip.blob);
        if (!base64) continue;
        payload.push({
          token: clip.token,
          transcript: clip.transcript,
          audioBase64: base64,
          audioType: clip.blob.type || capturedAudioPayload.mimeType || 'audio/webm',
          capturedAt: capturedAudioPayload.capturedAt,
        });
      }
      if (!payload.length) {
        clearCapturedAudio();
        return;
      }
      voiceApi.saveTokenRecordings(payload, {
        source: 'voice-model',
        prompt: context.prompt ?? capturedAudioPayload.originalTranscript,
        kind: context.kind,
      });
    } catch (error) {
      console.warn('Failed to persist voice model recordings:', error);
    } finally {
      clearCapturedAudio();
    }
  }

  function startLoadingBar(targetLatency: number): void {
    if (!loadingEl || !loadingProgress) return;
    if (loadingTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(loadingTimer);
      loadingTimer = null;
    }
    loadingEl.hidden = false;
    loadingProgress.style.width = '0%';
    if (loadingLabel) {
      loadingLabel.textContent = 'Synthesizing response…';
    }
    const duration = Math.max(900, Number.isFinite(targetLatency) ? targetLatency : 1200);
    const stepMs = 120;
    const steps = Math.max(1, Math.round(duration / stepMs));
    const increment = 95 / steps;
    let progress = 0;
    if (typeof window !== 'undefined') {
      loadingTimer = window.setInterval(() => {
        progress = Math.min(95, progress + increment);
        loadingProgress.style.width = `${progress}%`;
      }, stepMs);
    }
  }

  function stopLoadingBar(): void {
    if (!loadingEl || !loadingProgress) return;
    if (loadingTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(loadingTimer);
      loadingTimer = null;
    }
    loadingProgress.style.width = '100%';
    const hide = () => {
      loadingEl.hidden = true;
      loadingProgress.style.width = '0%';
    };
    if (typeof window !== 'undefined') {
      window.setTimeout(hide, 400);
    } else {
      hide();
    }
  }

  function startRecognition(): void {
    if (inFlight || recognitionActive) return;
    const ctor = getSpeechRecognitionConstructor();
    if (!ctor) {
      updateStatus('Speech recognition is not supported in this browser.');
      listeningRequested = false;
      updateMicButtonState();
      return;
    }
    hideTranscriptEditor();
    resumeListeningAfterSend = false;
    try {
      recognition = new ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = handleRecognitionResult;
      recognition.onerror = handleRecognitionError;
      recognition.onend = () => {
        void handleRecognitionEnd();
      };
      transcriptParts = [];
      interimTranscript = '';
      previousTokenCount = 0;
      updateTranscriptTokens('', '');
      void startAudioCapture();
      recognition.start();
      recognitionActive = true;
      updateOrbActive(true);
      updateStatus('Listening… blooming adjacency tokens in real time.');
      if (speakerButton) {
        speakerButton.disabled = true;
      }
    } catch (error) {
      console.warn('Unable to start speech recognition:', error);
      updateStatus('Microphone access denied or unavailable.');
      listeningRequested = false;
      updateMicButtonState();
      recognition = null;
      recognitionActive = false;
    }
  }

  function stopRecognition(): void {
    if (!recognition) {
      recognitionActive = false;
      updateOrbActive(false);
      return;
    }
    recognitionActive = false;
    try {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    } catch {
      try {
        recognition.abort?.();
      } catch {}
    }
    recognition = null;
    updateOrbActive(false);
  }

  function handleRecognitionResult(event: any): void {
    if (!event) return;
    let finalChanged = false;
    let interimValue = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result || !result[0]) continue;
      const value = typeof result[0].transcript === 'string' ? result[0].transcript.trim() : '';
      if (!value) continue;
      if (result.isFinal) {
        transcriptParts.push(value);
        noteAudioSegment(value);
        finalChanged = true;
      } else {
        interimValue = value;
      }
    }
    interimTranscript = interimValue;
    const finalText = transcriptParts.join(' ').trim();
    if (finalChanged && finalText) {
      updateStatus('Blooming adjacency tokens from captured speech…');
    } else if (interimValue) {
      updateStatus('Listening… capturing live transcript.');
    }
    updateTranscriptTokens(finalText, interimTranscript);
  }

  function handleRecognitionError(event: any): void {
    if (event && (event.error === 'not-allowed' || event.error === 'service-not-allowed')) {
      updateStatus('Microphone access denied. Enable permissions to use voice capture.');
      listeningRequested = false;
      stopRecognition();
      updateMicButtonState();
      return;
    }
    console.warn('Speech recognition error:', event);
    if (!listeningRequested || inFlight) return;
    updateStatus('Speech recognition interrupted. Attempting to recover…');
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (listeningRequested && !inFlight) {
          startRecognition();
        }
      }, 1000);
    }
  }

  async function handleRecognitionEnd(): Promise<void> {
    recognitionActive = false;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition = null;
    }
    updateOrbActive(false);
    const finalTranscript = transcriptParts.join(' ').trim();
    const transcriptSnapshot = transcriptParts.slice();
    const segmentSnapshot = currentAudioSegments.map(segment => ({ ...segment }));
    const captureTimestamp = audioCaptureStartedAt || new Date().toISOString();
    const audioStopPromise = stopAudioCapture().catch(error => {
      console.warn('Voice model audio capture stop failed:', error);
      return { blob: null as Blob | null, mimeType: '' };
    });

    if (!finalTranscript) {
      await audioStopPromise;
      clearCapturedAudio();
      if (listeningRequested && !inFlight) {
        if (typeof window !== 'undefined') {
          window.setTimeout(() => {
            if (listeningRequested && !inFlight) {
              startRecognition();
            }
          }, 250);
        } else {
          startRecognition();
        }
      } else if (!listeningRequested) {
        updateStatus('Listening paused');
      }
      return;
    }

    if (inFlight) {
      await audioStopPromise;
      clearCapturedAudio();
      return;
    }

    const { blob, mimeType } = await audioStopPromise;
    if (blob) {
      capturedAudioPayload = {
        blob,
        mimeType: blob.type || mimeType || 'audio/webm',
        segments: segmentSnapshot,
        transcriptParts: transcriptSnapshot,
        capturedAt: captureTimestamp,
        originalTranscript: finalTranscript,
      };
    } else {
      clearCapturedAudio();
    }

    transcriptParts = [];
    interimTranscript = '';
    previousTokenCount = finalTranscript ? finalTranscript.split(/\s+/).filter(Boolean).length : 0;
    if (listeningRequested) {
      resumeListeningAfterSend = true;
      listeningRequested = false;
      updateMicButtonState();
    }
    updateStatus('Transcript captured. Review, edit, and send when ready.');
    showTranscriptEditor(finalTranscript);
  }

  function setListening(active: boolean): void {
    listeningRequested = active;
    updateMicButtonState();
    if (active) {
      startRecognition();
    } else {
      stopRecognition();
      updateStatus('Listening paused');
    }
  }

  if (micButton) {
    micButton.addEventListener('click', () => {
      if (inFlight) return;
      setListening(!listeningRequested);
    });
  }

  if (transcriptEditor) {
    transcriptEditor.addEventListener('input', () => {
      const value = transcriptEditor.value ?? '';
      updateTranscriptTokens(value, '');
      updateEditorState();
    });
  }

  function sendCapturedTranscript(rawValue: string): void {
    if (inFlight) return;
    const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!trimmed) {
      updateStatus('Transcript is empty. Speak again or edit before sending.');
      return;
    }
    capturedTranscript = trimmed;
    updateTranscriptTokens(trimmed, '');
    if (promptInput) {
      promptInputPreviousValue = promptInput.value;
      promptInputPopulatedByVoice = true;
      promptInput.value = trimmed;
      if (typeof promptInput.focus === 'function') {
        promptInput.focus();
      }
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      promptInputPreviousValue = null;
      promptInputPopulatedByVoice = false;
      console.warn('Voice model prompt input not found; sending without mirroring command field.');
    }
    hideTranscriptEditor();
    processTranscript(trimmed);
  }

  if (transcriptSendButton && transcriptEditor) {
    transcriptSendButton.addEventListener('click', () => {
      sendCapturedTranscript(transcriptEditor.value ?? '');
    });
  }

  if (transcriptSendCapturedButton) {
    transcriptSendCapturedButton.addEventListener('click', () => {
      sendCapturedTranscript(capturedTranscript);
    });
  }

  if (transcriptClearButton) {
    transcriptClearButton.addEventListener('click', () => {
      if (inFlight) return;
      hideTranscriptEditor();
      updateTranscriptTokens('', '');
      previousTokenCount = 0;
      clearCapturedAudio();
      updateStatus('Transcript cleared. Ready to capture new input.');
      const shouldResume = resumeListeningAfterSend;
      resumeListeningAfterSend = false;
      if (shouldResume && !listeningRequested) {
        setListening(true);
      }
    });
  }

  if (latencyInput) {
    latencyInput.addEventListener('change', () => {
      const value = Number(latencyInput.value);
      settings = {
        ...settings,
        latency: Number.isFinite(value) ? Math.max(0, Math.round(value)) : settings.latency,
      };
      writeSettings(settings);
      updateStatus(`Latency target set to ${settings.latency}ms.`);
    });
  }

  if (fftInput) {
    fftInput.addEventListener('input', () => {
      const value = Number(fftInput.value);
      settings = {
        ...settings,
        fftSensitivity: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : settings.fftSensitivity,
      };
      writeSettings(settings);
    });
  }

  function renderMetrics(state: ReturnType<UserAvatarStore['getState']>): void {
    if (!metricsContainer) return;
    const entries = metricsContainer.querySelectorAll<HTMLElement>('[data-metric]');
    entries.forEach(entry => {
      const key = entry.dataset.metric;
      switch (key) {
        case 'interactions':
          entry.textContent = String(state.metrics.totalInteractions);
          break;
        case 'tokens':
          entry.textContent = String(state.metrics.totalTokens);
          break;
        case 'blooms':
          entry.textContent = String(state.metrics.adjacencyBloomEvents);
          break;
        case 'updated':
          entry.textContent = formatTimestamp(state.metrics.lastUpdated);
          break;
        default:
          break;
      }
    });
  }

  function renderLog(state: ReturnType<UserAvatarStore['getState']>): void {
    if (!logContainer) return;
    const fragments = document.createDocumentFragment();
    const entries = [...state.entries].sort((a, b) => b.timestamp - a.timestamp);

    for (const entry of entries) {
      const item = document.createElement('article');
      item.className = `voice-model-log-entry status-${entry.status}`;
      const meta = document.createElement('div');
      meta.className = 'voice-model-log-entry__meta';
      const prompt = document.createElement('div');
      prompt.className = 'voice-model-log-entry__prompt';
      prompt.innerHTML = escapeHtml(entry.prompt);
      const metaInfo = document.createElement('span');
      const tokenInfo = entry.tokens.length
        ? `${entry.tokens.length} tokens · ${entry.newTokenCount ?? 0} new`
        : 'Pending tokens';
      metaInfo.innerHTML = `${tokenInfo}`;
      const timestamp = document.createElement('time');
      timestamp.dateTime = new Date(entry.timestamp).toISOString();
      timestamp.textContent = formatTimestamp(entry.timestamp);
      meta.append(metaInfo, timestamp);

      const status = document.createElement('div');
      status.className = 'voice-model-log-entry__status';
      status.textContent = entry.responseSummary || describeStatus(entry);

      item.append(prompt, meta, status);
      fragments.appendChild(item);
    }

    logContainer.innerHTML = '';
    logContainer.appendChild(fragments);
  }

  const unsubscribe = options.userAvatar.subscribe(state => {
    renderLog(state);
    renderMetrics(state);
  });

  function finalizeInteraction(
    interactionId: string,
    result: { success: boolean; tokens: string[]; kind: 'prompt' | 'command'; error?: unknown },
    prompt: string,
  ): void {
    const summary = result.success
      ? result.kind === 'command'
        ? 'Command executed via voice model interface.'
        : 'Prompt processed via cognition engine.'
      : `Failed: ${result.error instanceof Error ? result.error.message : 'See console for details.'}`;

    options.userAvatar.updateInteraction(interactionId, {
      status: result.success ? 'completed' : 'failed',
      tokens: result.tokens,
      responseSummary: summary,
    });

    if (result.success) {
      const playbackText = resolveLocalPlaybackText();
      lastPlaybackText = playbackText;

      if (options.onTokensCommitted) {
        options.onTokensCommitted(result.tokens, { prompt, kind: result.kind });
      }

      if (speakerButton) {
        speakerButton.disabled = !playbackText;
      }

      if (result.kind !== 'command') {
        if (playbackText) {
          updateStatus('Playing local HLSF AGI output.');
          speakText(playbackText);
        } else {
          updateStatus('Local HLSF AGI output unavailable for playback.');
        }
      }
    } else if (speakerButton) {
      speakerButton.disabled = true;
    }
  }

  async function processTranscript(transcript: string): Promise<void> {
    if (inFlight) return;
    const trimmed = typeof transcript === 'string' ? transcript.trim() : '';
    if (!trimmed) {
      updateStatus(listeningRequested ? 'Listening… awaiting speech.' : 'Awaiting input');
      return;
    }

    inFlight = true;
    updateMicButtonState();
    updateStatus('Blooming captured speech into HLSF memory…');
    updateOrbActive(false);
    startLoadingBar(settings.latency);

    const interaction = options.userAvatar.recordInteraction({
      prompt: trimmed,
      status: 'processing',
    });
    currentInteractionId = interaction.id;

    if (speakerButton) {
      speakerButton.disabled = true;
    }

    try {
      const result = await options.submitPrompt(trimmed, { annotateLog: true });
      finalizeInteraction(currentInteractionId, result, trimmed);
      if (result.success) {
        void commitCapturedAudioRecordings(result.tokens, { prompt: trimmed, kind: result.kind }).catch(error => {
          console.warn('Voice model recording ingestion failed:', error);
        });
      } else {
        clearCapturedAudio();
      }
    } catch (error) {
      if (currentInteractionId) {
        options.userAvatar.updateInteraction(currentInteractionId, {
          status: 'failed',
          responseSummary: error instanceof Error ? error.message : 'Voice processing failed',
        });
      }
      console.error('Voice model processing failed:', error);
      clearCapturedAudio();
    } finally {
      stopLoadingBar();
      inFlight = false;
      currentInteractionId = null;
      updateMicButtonState();
      if (promptInput && promptInputPopulatedByVoice) {
        const nextValue = promptInputPreviousValue ?? '';
        promptInput.value = nextValue;
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      promptInputPreviousValue = null;
      promptInputPopulatedByVoice = false;
      const shouldResume = resumeListeningAfterSend;
      resumeListeningAfterSend = false;
      if (shouldResume) {
        setListening(true);
      } else if (listeningRequested) {
        updateStatus('Ready for the next utterance.');
      } else {
        updateStatus('Listening paused');
      }
    }
  }

  if (speakerButton) {
    speakerButton.disabled = true;
    speakerButton.addEventListener('click', () => {
      if (!lastPlaybackText) {
        updateStatus('No local HLSF AGI output available for playback.');
        return;
      }
      speakText(lastPlaybackText);
      updateStatus('Playing local HLSF AGI output.');
    });
  }

  hideTranscriptEditor();
  updateTranscriptTokens('', '');
  updateMicButtonState();

  const recognitionCtor = getSpeechRecognitionConstructor();
  if (recognitionCtor) {
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (!listeningRequested && !inFlight) {
          setListening(true);
        }
      }, 300);
    } else if (!listeningRequested) {
      setListening(true);
    }
  } else {
    updateStatus('Speech recognition is not supported in this browser.');
  }

  function cleanup(): void {
    unsubscribe();
  }

  root.addEventListener('dispose', cleanup, { once: true });

  return {
    focus() {
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (micButton) {
        micButton.focus();
      }
    },
  };
}

type TokenTiming = {
  token: string;
  transcript: string;
  startSec: number;
  endSec: number;
};

async function generateTokenRecordingsFromCapture(
  tokens: string[],
  payload: CapturedAudioPayload,
  options: { preRoll: number; postRoll: number; minimumTokenDuration: number },
): Promise<TokenAudioClip[]> {
  if (!payload || !payload.blob) return [];
  const sanitizedTokens = Array.isArray(tokens)
    ? tokens.map(token => (typeof token === 'string' ? token.trim() : '')).filter(Boolean)
    : [];
  if (!sanitizedTokens.length) return [];
  if (typeof window === 'undefined') return [];
  const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (typeof AudioContextCtor !== 'function') return [];

  const arrayBuffer = await payload.blob.arrayBuffer();
  const context = new AudioContextCtor();
  try {
    const audioBuffer = await decodeAudioBuffer(context, arrayBuffer);
    const timings = computeTokenTimings(sanitizedTokens, payload, options, audioBuffer.duration);
    if (!timings.length) return [];
    const clips: TokenAudioClip[] = [];
    const { numberOfChannels, sampleRate } = audioBuffer;
    for (const timing of timings) {
      const startSample = Math.max(0, Math.floor(timing.startSec * sampleRate));
      const endSample = Math.min(audioBuffer.length, Math.ceil(timing.endSec * sampleRate));
      if (endSample <= startSample) continue;
      const length = endSample - startSample;
      const segmentBuffer = context.createBuffer(numberOfChannels, length, sampleRate);
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const channelData = audioBuffer.getChannelData(channel).subarray(startSample, endSample);
        if (typeof segmentBuffer.copyToChannel === 'function') {
          segmentBuffer.copyToChannel(channelData, channel);
        } else {
          segmentBuffer.getChannelData(channel).set(channelData);
        }
      }
      const wavBuffer = audioBufferToWav(segmentBuffer);
      clips.push({
        token: timing.token,
        transcript: timing.transcript,
        blob: new Blob([wavBuffer], { type: 'audio/wav' }),
      });
    }
    return clips;
  } catch (error) {
    console.warn('Voice model audio decoding failed:', error);
    return [];
  } finally {
    try {
      await context.close();
    } catch {}
  }
}

function computeTokenTimings(
  tokens: string[],
  payload: CapturedAudioPayload,
  options: { preRoll: number; postRoll: number; minimumTokenDuration: number },
  totalDuration: number,
): TokenTiming[] {
  const minDuration = Math.max(0.01, options.minimumTokenDuration);
  const fallbackTokens = (payload.transcriptParts || [])
    .join(' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const normalizedSegments = segments.length
    ? segments
        .map(segment => {
          const baseStart = Math.max(0, segment.startMs / 1000 - options.preRoll);
          const baseEnd = Math.min(totalDuration, segment.endMs / 1000 + options.postRoll);
          const segmentTokens = typeof segment.text === 'string'
            ? segment.text.split(/\s+/).map(token => token.trim()).filter(Boolean)
            : [];
          const startSec = Math.max(0, Math.min(baseStart, totalDuration));
          const endSec = Math.max(startSec + minDuration, Math.min(baseEnd, totalDuration));
          return { startSec, endSec, tokens: segmentTokens };
        })
        .sort((a, b) => a.startSec - b.startSec)
    : [
        {
          startSec: 0,
          endSec: Math.max(totalDuration, minDuration * tokens.length || minDuration),
          tokens: fallbackTokens.length ? fallbackTokens : [...tokens],
        },
      ];

  const timings: TokenTiming[] = [];
  let tokenIndex = 0;
  let previousEnd = 0;
  for (const segment of normalizedSegments) {
    if (tokenIndex >= tokens.length) break;
    const segmentTokenCount = segment.tokens.length || Math.min(tokens.length - tokenIndex, 1);
    const availableTokens = Math.min(segmentTokenCount, tokens.length - tokenIndex);
    const startSec = Math.max(previousEnd, Math.min(segment.startSec, totalDuration));
    const endSec = Math.max(startSec + minDuration * availableTokens, Math.min(segment.endSec, totalDuration));
    const duration = Math.max(endSec - startSec, minDuration * availableTokens);
    const perToken = duration / availableTokens;
    for (let i = 0; i < availableTokens && tokenIndex < tokens.length; i++) {
      const token = tokens[tokenIndex];
      const tokenStart = startSec + perToken * i;
      let tokenEnd = i === availableTokens - 1 ? endSec : tokenStart + perToken;
      if (tokenEnd - tokenStart < minDuration) {
        tokenEnd = tokenStart + minDuration;
      }
      const clampedStart = Math.max(0, Math.min(tokenStart, totalDuration));
      const clampedEnd = Math.max(clampedStart + minDuration / 2, Math.min(tokenEnd, totalDuration));
      timings.push({
        token,
        transcript: token,
        startSec: clampedStart,
        endSec: clampedEnd,
      });
      tokenIndex += 1;
    }
    previousEnd = Math.max(previousEnd, endSec);
  }

  if (tokenIndex < tokens.length) {
    const remaining = tokens.length - tokenIndex;
    const startSec = timings.length ? timings[timings.length - 1].endSec : 0;
    const available = Math.max(totalDuration - startSec, minDuration * remaining);
    const perToken = available / remaining;
    for (let i = 0; i < remaining && tokenIndex < tokens.length; i++) {
      const token = tokens[tokenIndex];
      const tokenStart = startSec + perToken * i;
      let tokenEnd = tokenStart + perToken;
      if (tokenEnd - tokenStart < minDuration) {
        tokenEnd = tokenStart + minDuration;
      }
      timings.push({
        token,
        transcript: token,
        startSec: Math.max(0, Math.min(tokenStart, totalDuration)),
        endSec: Math.max(minDuration, Math.min(tokenEnd, totalDuration)),
      });
      tokenIndex += 1;
    }
  }

  return timings;
}

function decodeAudioBuffer(context: AudioContext, arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const cloned = arrayBuffer.slice(0);
    context.decodeAudioData(
      cloned,
      decoded => resolve(decoded),
      error => reject(error || new Error('Unable to decode audio data.')),
    );
  });
}

function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitsPerSample = 16;
  const format = 1;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  const channelData = [] as Float32Array[];
  for (let channel = 0; channel < channels; channel++) {
    channelData.push(buffer.getChannelData(channel));
  }
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < channels; channel++) {
      let sample = channelData[channel][i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return arrayBuffer;
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        const base64 = result.split(',')[1] || '';
        resolve(base64);
      } else {
        reject(new Error('Unexpected FileReader result.'));
      }
    };
    reader.onerror = err => reject(err);
    reader.readAsDataURL(blob);
  });
}
