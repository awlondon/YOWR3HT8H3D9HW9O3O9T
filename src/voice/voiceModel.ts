import type { AvatarInteraction, UserAvatarStore } from '../userAvatar/index';

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
  const statusEl = root.querySelector<HTMLElement>('#voice-model-status');
  const processButton = root.querySelector<HTMLButtonElement>('#voice-model-process');
  const transcriptInput = root.querySelector<HTMLTextAreaElement>('#voice-model-manual-transcript');
  const latencyInput = root.querySelector<HTMLInputElement>('#voice-model-latency');
  const fftInput = root.querySelector<HTMLInputElement>('#voice-model-fft');
  const logContainer = root.querySelector<HTMLElement>('#voice-model-log');
  const metricsContainer = root.querySelector<HTMLElement>('#voice-avatar-metrics');

  let isListening = false;
  let lastPlaybackText = '';
  let settings = readSettings();
  let currentInteractionId: string | null = null;
  let inFlight = false;

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

  function setListening(active: boolean): void {
    isListening = active;
    updateOrbActive(active);
    if (micButton) {
      micButton.textContent = active ? 'Stop listening' : 'Start listening';
      micButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    updateStatus(active ? 'Listening… capturing FFT stream.' : 'Awaiting input');
    if (!active && transcriptInput) {
      transcriptInput.focus();
    }
  }

  if (micButton) {
    micButton.addEventListener('click', () => {
      if (inFlight) return;
      setListening(!isListening);
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
    } else if (speakerButton) {
      speakerButton.disabled = true;
    }
  }

  async function processTranscript(): Promise<void> {
    if (inFlight) return;
    const transcript = transcriptInput?.value?.trim() || '';
    if (!transcript) {
      updateStatus('Provide a transcript to bloom adjacencies.');
      return;
    }

    inFlight = true;
    updateStatus('Blooming transcript into HLSF memory…');
    currentInteractionId = options.userAvatar.recordInteraction({
      prompt: transcript,
      status: 'processing',
    }).id;

    try {
      const result = await options.submitPrompt(transcript, { annotateLog: true });
      finalizeInteraction(currentInteractionId, result, transcript);
      if (transcriptInput) transcriptInput.value = '';
    } catch (error) {
      options.userAvatar.updateInteraction(currentInteractionId, {
        status: 'failed',
        responseSummary: error instanceof Error ? error.message : 'Voice processing failed',
      });
      console.error('Voice model processing failed:', error);
    } finally {
      inFlight = false;
      currentInteractionId = null;
      setListening(false);
      updateStatus('Awaiting input');
    }
  }

  if (processButton) {
    processButton.addEventListener('click', () => {
      processTranscript().catch(error => console.error(error));
    });
  }

  if (transcriptInput) {
    transcriptInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        processTranscript().catch(error => console.error(error));
      }
    });
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

  function cleanup(): void {
    unsubscribe();
  }

  root.addEventListener('dispose', cleanup, { once: true });

  return {
    focus() {
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (transcriptInput) transcriptInput.focus();
    },
  };
}
