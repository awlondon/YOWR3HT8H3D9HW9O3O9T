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
  onTokensCommitted?: (tokens: string[]) => void;
}

interface VoiceModelSettings {
  latency: number;
  fftSensitivity: number;
}

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
    const tokens = finalText ? finalText.split(/\s+/).filter(Boolean) : [];
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
      recognition.onend = handleRecognitionEnd;
      transcriptParts = [];
      interimTranscript = '';
      previousTokenCount = 0;
      updateTranscriptTokens('', '');
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

  function handleRecognitionEnd(): void {
    recognitionActive = false;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition = null;
    }
    updateOrbActive(false);
    const finalTranscript = transcriptParts.join(' ').trim();
    if (!finalTranscript) {
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
      return;
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

  if (transcriptSendButton && transcriptEditor) {
    transcriptSendButton.addEventListener('click', () => {
      if (inFlight) return;
      const value = transcriptEditor.value ?? '';
      const trimmed = value.trim();
      if (!trimmed) {
        updateStatus('Transcript is empty. Speak again or edit before sending.');
        return;
      }
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
    });
  }

  if (transcriptClearButton) {
    transcriptClearButton.addEventListener('click', () => {
      if (inFlight) return;
      hideTranscriptEditor();
      updateTranscriptTokens('', '');
      previousTokenCount = 0;
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
      lastPlaybackText = `Voice session processed: ${prompt}`;
      if (options.onTokensCommitted && result.tokens.length) {
        options.onTokensCommitted(result.tokens);
      }
      if (speakerButton) {
        speakerButton.disabled = false;
      }
      if (result.kind !== 'command' && lastPlaybackText) {
        updateStatus('Playing synthesized response profile.');
        speakText(lastPlaybackText);
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
    } catch (error) {
      if (currentInteractionId) {
        options.userAvatar.updateInteraction(currentInteractionId, {
          status: 'failed',
          responseSummary: error instanceof Error ? error.message : 'Voice processing failed',
        });
      }
      console.error('Voice model processing failed:', error);
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
        updateStatus('No synthesized response available yet.');
        return;
      }
      speakText(lastPlaybackText);
      updateStatus('Playing synthesized response profile.');
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
