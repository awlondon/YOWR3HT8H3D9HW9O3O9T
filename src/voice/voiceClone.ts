// @ts-nocheck

const STORAGE_KEY = 'HLSF_VOICE_CLONE_STATE_V1';
const TOKENS_CHANGED_EVENT = 'voice:tokens-changed';
const DATABASE_READY_EVENT = 'hlsf:database-ready';
const MAX_RENDERED_TOKENS = 800;

function defaultVoicePreferences() {
  return {
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
  };
}

function defaultVoiceStore() {
  return {
    recordings: [],
    assignments: {},
    profileRecordingId: null,
    voicePreferences: defaultVoicePreferences(),
  };
}

let store = defaultVoiceStore();

const panelState = {
  tokens: [],
  filter: '',
  selectedToken: null,
  selectedRecordingId: null,
  isRecording: false,
  activeTranscript: '',
  status: { message: '', type: 'info' },
};

const elements = {
  panel: null,
  tokenList: null,
  detail: null,
  search: null,
  refresh: null,
  status: null,
};

let panelReady = false;
let pendingTokenRefresh = false;
let voiceOptionsBound = false;
let activePlayback = null;
let activeRecorder = null;
const audioUrlCache = new Map();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function cssEscape(value) {
  const str = value == null ? '' : String(value);
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(str);
  }
  return str.replace(/[^a-zA-Z0-9_\-]/g, ch => `\\${ch}`);
}

function loadVoiceStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultVoiceStore();
    const parsed = JSON.parse(raw);
    const normalized = defaultVoiceStore();
    if (Array.isArray(parsed?.recordings)) normalized.recordings = parsed.recordings.map(normalizeRecording).filter(Boolean);
    if (parsed?.assignments && typeof parsed.assignments === 'object') normalized.assignments = { ...parsed.assignments };
    if (typeof parsed?.profileRecordingId === 'string') normalized.profileRecordingId = parsed.profileRecordingId;
    if (parsed?.voicePreferences && typeof parsed.voicePreferences === 'object') {
      normalized.voicePreferences = Object.assign(defaultVoicePreferences(), parsed.voicePreferences);
    }
    return normalized;
  } catch (err) {
    console.warn('Failed to load voice clone store:', err);
    return defaultVoiceStore();
  }
}

function normalizeRecording(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' && entry.id ? entry.id : null;
  const token = typeof entry.token === 'string' ? entry.token : null;
  if (!id || !token) return null;
  return {
    id,
    token,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    audioBase64: typeof entry.audioBase64 === 'string' ? entry.audioBase64 : '',
    audioType: typeof entry.audioType === 'string' ? entry.audioType : 'audio/webm',
    transcript: typeof entry.transcript === 'string' ? entry.transcript : token,
    tags: Array.isArray(entry.tags) ? entry.tags.filter(Boolean).map(String) : [],
    iteration: Number.isFinite(entry.iteration) ? Number(entry.iteration) : 1,
    sourceToken: typeof entry.sourceToken === 'string' ? entry.sourceToken : token,
  };
}

function saveVoiceStore() {
  try {
    const payload = JSON.stringify(store);
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (err) {
    console.warn('Unable to persist voice clone store:', err);
  }
}

function gatherTokens() {
  const tokenSet = new Set();
  (store.recordings || []).forEach(rec => tokenSet.add(rec.token));
  Object.keys(store.assignments || {}).forEach(token => tokenSet.add(token));
  const state = window.CognitionEngine?.state;
  if (Array.isArray(state?.tokenOrder)) {
    for (const token of state.tokenOrder) {
      if (token) tokenSet.add(token);
      if (tokenSet.size >= MAX_RENDERED_TOKENS * 2) break;
    }
  }
  const cache = window.CognitionEngine?.cache;
  if (cache && typeof cache.list === 'function') {
    try {
      const cachedTokens = cache.list(MAX_RENDERED_TOKENS * 2) || [];
      for (const token of cachedTokens) {
        if (token) tokenSet.add(token);
        if (tokenSet.size >= MAX_RENDERED_TOKENS * 2) break;
      }
    } catch (err) {
      console.warn('Unable to list cached tokens for voice panel:', err);
    }
  }
  const db = window.HLSF?.dbCache;
  if (Array.isArray(db?.full_token_data)) {
    for (const record of db.full_token_data) {
      if (record?.token) tokenSet.add(record.token);
      if (tokenSet.size >= MAX_RENDERED_TOKENS * 2) break;
    }
  }
  return Array.from(tokenSet)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

function buildRecordingIndex() {
  const map = new Map();
  for (const rec of store.recordings || []) {
    if (!rec?.token) continue;
    if (!map.has(rec.token)) map.set(rec.token, []);
    map.get(rec.token).push(rec);
  }
  for (const [, list] of map) {
    list.sort((a, b) => {
      const timeA = Date.parse(a.createdAt) || 0;
      const timeB = Date.parse(b.createdAt) || 0;
      return timeB - timeA;
    });
  }
  return map;
}

let recordingIndex = buildRecordingIndex();

function setStatus(message, type = 'info') {
  panelState.status = { message, type };
  if (elements.status) {
    elements.status.textContent = message || '';
    elements.status.className = `voice-status-message ${type || ''}`.trim();
  }
}

function refreshTokens() {
  if (!panelReady) {
    pendingTokenRefresh = true;
    return;
  }
  recordingIndex = buildRecordingIndex();
  panelState.tokens = gatherTokens();
  if (panelState.selectedToken && !panelState.tokens.includes(panelState.selectedToken)) {
    panelState.selectedToken = panelState.tokens[0] || null;
  }
  if (!panelState.selectedToken && panelState.tokens.length) {
    panelState.selectedToken = panelState.tokens[0];
  }
  renderTokenList();
  renderTokenDetail();
  pendingTokenRefresh = false;
}

function renderTokenList() {
  if (!elements.tokenList) return;
  const filter = panelState.filter.trim().toLowerCase();
  const tokenStats = new Map();
  for (const [token, list] of recordingIndex) {
    tokenStats.set(token, list.length);
  }
  const items = [];
  let rendered = 0;
  for (const token of panelState.tokens) {
    if (filter && !token.toLowerCase().includes(filter)) continue;
    rendered += 1;
    if (rendered > MAX_RENDERED_TOKENS) break;
    const assignedId = store.assignments?.[token] || null;
    const recordings = tokenStats.get(token) || 0;
    const hasAssigned = Boolean(assignedId);
    const statusLabel = hasAssigned
      ? 'Voice mapped'
      : recordings > 0
        ? `${recordings} recording${recordings === 1 ? '' : 's'}`
        : 'No voice data';
    const disabledAssigned = hasAssigned ? '' : 'disabled';
    const disabledTts = typeof window.speechSynthesis === 'undefined' ? 'disabled' : '';
    const selectedClass = panelState.selectedToken === token ? 'selected' : '';
    items.push(`
      <li class="voice-token-item ${selectedClass}">
        <button class="voice-token-name" data-action="select-token" data-token="${escapeAttr(token)}">${escapeHtml(token)}</button>
        <span class="voice-token-meta">${escapeHtml(statusLabel)}</span>
        <div class="voice-token-actions">
          <button type="button" data-action="play-assigned" data-token="${escapeAttr(token)}" ${disabledAssigned}>▶</button>
          <button type="button" data-action="play-tts" data-token="${escapeAttr(token)}" ${disabledTts}>🔊</button>
        </div>
      </li>`);
  }
  if (!items.length) {
    elements.tokenList.innerHTML = '<li class="voice-token-item"><span class="voice-token-name">No tokens available</span></li>';
  } else {
    elements.tokenList.innerHTML = items.join('');
  }
}

function renderTokenDetail() {
  if (!elements.detail) return;
  const token = panelState.selectedToken;
  if (!token) {
    elements.detail.innerHTML = '<p class="voice-detail-placeholder">Select a cache token to begin recording and mapping your voice profile.</p>';
    setStatus('', 'info');
    return;
  }
  const recordings = recordingIndex.get(token) || [];
  const assignedId = store.assignments?.[token] || null;
  const assignedRecording = assignedId ? store.recordings.find(rec => rec.id === assignedId) : null;
  const recCount = recordings.length;
  const recordingLabel = recCount === 1 ? '1 recording' : `${recCount} recordings`;
  const ttsDisabled = typeof window.speechSynthesis === 'undefined';
  const assignedMarkup = assignedRecording
    ? renderAssignedBlock(assignedRecording)
    : '<div class="voice-assigned-block"><em>No voice mapped to this token yet.</em></div>';
  const recordingsMarkup = recordings.length
    ? `<div class="voice-recordings-list">${recordings.map(renderRecordingCard).join('')}</div>`
    : '<div class="voice-recordings-list"><div class="voice-recording-card"><em>No recordings captured for this token yet.</em></div></div>';

  const voicePrefs = store.voicePreferences || defaultVoicePreferences();
  const recordBtnLabel = panelState.isRecording ? 'Recording…' : 'Record new iteration';
  const stopButton = panelState.isRecording ? '<button type="button" data-action="stop-recording">Stop recording</button>' : '';

  elements.detail.innerHTML = `
    <div class="voice-detail-header">
      <h3>${escapeHtml(token)}</h3>
      <span class="voice-iteration-count">${escapeHtml(recordingLabel)}</span>
    </div>
    <div class="voice-detail-actions">
      <button type="button" data-action="start-recording" ${panelState.isRecording ? 'disabled' : ''}>${escapeHtml(recordBtnLabel)}</button>
      ${stopButton}
      <button type="button" data-action="play-assigned" ${assignedRecording ? '' : 'disabled'} data-recording-id="${assignedRecording ? escapeAttr(assignedRecording.id) : ''}">Play assigned voice</button>
      <button type="button" data-action="play-tts" ${ttsDisabled ? 'disabled' : ''}>Play TTS preview</button>
    </div>
    ${panelState.isRecording ? `<div class="voice-live-transcript" data-role="live-transcript">${escapeHtml(panelState.activeTranscript || 'Listening…')}</div>` : ''}
    <div class="voice-voice-settings">
      <label>
        Speech synthesis voice
        <select data-role="voice-select" ${ttsDisabled ? 'disabled' : ''}></select>
      </label>
      <label>
        Pitch <span data-role="voice-pitch-display">${voicePrefs.pitch.toFixed(2)}</span>
        <input type="range" min="0.5" max="2" step="0.05" value="${voicePrefs.pitch}" data-role="voice-pitch">
      </label>
      <label>
        Rate <span data-role="voice-rate-display">${voicePrefs.rate.toFixed(2)}</span>
        <input type="range" min="0.5" max="2.5" step="0.05" value="${voicePrefs.rate}" data-role="voice-rate">
      </label>
      <label>
        Volume <span data-role="voice-volume-display">${voicePrefs.volume.toFixed(2)}</span>
        <input type="range" min="0" max="1" step="0.05" value="${voicePrefs.volume}" data-role="voice-volume">
      </label>
    </div>
    ${assignedMarkup}
    ${recordingsMarkup}
  `;

  populateVoiceSelect();
  setStatus(panelState.status?.message || '', panelState.status?.type || 'info');
}

function renderAssignedBlock(recording) {
  const tags = (recording.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('');
  const transcript = recording.transcript ? `<div><strong>Transcript:</strong> ${escapeHtml(recording.transcript)}</div>` : '';
  const origin = recording.token && recording.token !== panelState.selectedToken
    ? `<div><strong>Captured on:</strong> ${escapeHtml(recording.token)}</div>`
    : '';
  return `
    <div class="voice-assigned-block" data-assigned-recording="${escapeAttr(recording.id)}">
      <div><strong>Assigned voice:</strong> Iteration ${escapeHtml(String(recording.iteration || 1))}</div>
      ${origin}
      ${transcript}
      <div class="voice-tags">${tags || '<span>no tags yet</span>'}</div>
      <div class="voice-recording-actions">
        <button type="button" data-action="play-recording" data-recording-id="${escapeAttr(recording.id)}">Play recording</button>
        <button type="button" data-action="set-profile" data-recording-id="${escapeAttr(recording.id)}">${store.profileRecordingId === recording.id ? 'Profile voice' : 'Use as voice profile'}</button>
      </div>
    </div>
  `;
}

function renderRecordingCard(recording) {
  const assignedTokens = listTokensForRecording(recording.id);
  const assignedText = assignedTokens.length ? escapeHtml(assignedTokens.join(', ')) : '';
  const isActive = panelState.selectedRecordingId === recording.id;
  const badge = store.profileRecordingId === recording.id ? '<span class="badge">Voice profile</span>' : '';
  const created = recording.createdAt ? new Date(recording.createdAt).toLocaleString() : '';
  return `
    <div class="voice-recording-card ${isActive ? 'active' : ''}" data-action="select-recording" data-recording-id="${escapeAttr(recording.id)}">
      <div class="voice-recording-header">
        <span><strong>Iteration ${escapeHtml(String(recording.iteration || 1))}</strong> · ${escapeHtml(created)}</span>
        ${badge}
      </div>
      <div class="voice-recording-meta">
        <div><strong>Transcript:</strong> ${escapeHtml(recording.transcript || recording.token)}</div>
        <div><strong>Tags:</strong> ${(recording.tags || []).length ? escapeHtml(recording.tags.join(', ')) : '—'}</div>
        ${assignedText ? `<div><strong>Mapped tokens:</strong> ${assignedText}</div>` : ''}
      </div>
      <audio controls src="${escapeAttr(getRecordingUrl(recording))}"></audio>
      <div class="voice-recording-editor">
        <label>Metadata tags (comma separated)</label>
        <input type="text" class="voice-tag-input" data-recording-id="${escapeAttr(recording.id)}" value="${escapeAttr((recording.tags || []).join(', '))}" />
        <button type="button" data-action="save-tags" data-recording-id="${escapeAttr(recording.id)}">Save tags</button>
      </div>
      <div class="voice-recording-assign">
        <label>Map recording to tokens</label>
        <textarea class="voice-assignment-input" data-recording-id="${escapeAttr(recording.id)}" placeholder="token a, token b">${escapeHtml(assignedTokens.join(', '))}</textarea>
        <button type="button" data-action="apply-assignment" data-recording-id="${escapeAttr(recording.id)}">Apply mapping</button>
      </div>
      <div class="voice-recording-actions">
        <button type="button" data-action="play-recording" data-recording-id="${escapeAttr(recording.id)}">Play</button>
        <button type="button" data-action="set-profile" data-recording-id="${escapeAttr(recording.id)}">${store.profileRecordingId === recording.id ? 'Profile voice' : 'Use as voice profile'}</button>
        <button type="button" data-action="delete-recording" data-recording-id="${escapeAttr(recording.id)}">Delete</button>
      </div>
    </div>
  `;
}

function getRecordingUrl(recording) {
  if (!recording || !recording.id) return '';
  if (audioUrlCache.has(recording.id)) return audioUrlCache.get(recording.id);
  const mime = recording.audioType || 'audio/webm';
  const url = `data:${mime};base64,${recording.audioBase64 || ''}`;
  audioUrlCache.set(recording.id, url);
  return url;
}

function listTokensForRecording(recordingId) {
  const out = [];
  for (const [token, assigned] of Object.entries(store.assignments || {})) {
    if (assigned === recordingId) out.push(token);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

function selectToken(token) {
  if (!token) return;
  panelState.selectedToken = token;
  panelState.selectedRecordingId = store.assignments?.[token] || null;
  panelState.activeTranscript = '';
  renderTokenList();
  renderTokenDetail();
}

function playAssignedForToken(token) {
  if (!token) return;
  const assignedId = store.assignments?.[token];
  if (!assignedId) {
    setStatus('No voice has been assigned to this token yet.', 'warning');
    return;
  }
  playRecordingById(assignedId);
}

function playRecordingById(recordingId) {
  if (!recordingId) return;
  const recording = store.recordings.find(rec => rec.id === recordingId);
  if (!recording) {
    setStatus('Unable to locate the requested recording.', 'error');
    return;
  }
  if (activePlayback) {
    try { activePlayback.pause(); } catch {}
    activePlayback = null;
  }
  const audio = new Audio(getRecordingUrl(recording));
  audio.play().catch(err => console.warn('Failed to play recording:', err));
  activePlayback = audio;
  setStatus('Playing recorded voice sample.', 'info');
}

function playTokenTts(token) {
  if (typeof window.speechSynthesis === 'undefined') {
    setStatus('Speech synthesis is not available in this browser.', 'error');
    return;
  }
  if (!token) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(token);
  const prefs = store.voicePreferences || defaultVoicePreferences();
  utterance.rate = Number.isFinite(prefs.rate) ? prefs.rate : 1;
  utterance.pitch = Number.isFinite(prefs.pitch) ? prefs.pitch : 1;
  utterance.volume = Number.isFinite(prefs.volume) ? prefs.volume : 1;
  const voices = window.speechSynthesis.getVoices();
  if (prefs.voiceURI && Array.isArray(voices) && voices.length) {
    const voice = voices.find(v => v.voiceURI === prefs.voiceURI);
    if (voice) utterance.voice = voice;
  }
  window.speechSynthesis.speak(utterance);
  setStatus('Playing token using speech synthesis voice profile.', 'info');
}

function populateVoiceSelect() {
  if (!elements.detail) return;
  const select = elements.detail.querySelector('select[data-role="voice-select"]');
  if (!select) return;
  if (typeof window.speechSynthesis === 'undefined') {
    select.innerHTML = '<option value="">Speech synthesis unavailable</option>';
    return;
  }
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) {
    select.innerHTML = '<option value="">Loading voices…</option>';
    if (!voiceOptionsBound) {
      voiceOptionsBound = true;
      const rebinder = () => populateVoiceSelect();
      try {
        window.speechSynthesis.addEventListener('voiceschanged', rebinder);
      } catch {
        window.speechSynthesis.onvoiceschanged = rebinder;
      }
    }
    return;
  }
  const options = ['<option value="">System default</option>'];
  for (const voice of voices) {
    options.push(`<option value="${escapeAttr(voice.voiceURI)}">${escapeHtml(`${voice.name} (${voice.lang})`)}</option>`);
  }
  select.innerHTML = options.join('');
  const prefs = store.voicePreferences || defaultVoicePreferences();
  if (prefs.voiceURI) {
    select.value = prefs.voiceURI;
  }
}

function handleTokenListClick(event) {
  const target = event.target?.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const token = target.dataset.token;
  switch (action) {
    case 'select-token':
      selectToken(token);
      break;
    case 'play-assigned':
      playAssignedForToken(token);
      break;
    case 'play-tts':
      playTokenTts(token);
      break;
    default:
      break;
  }
}

function handleDetailClick(event) {
  const target = event.target?.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const recordingId = target.dataset.recordingId;
  switch (action) {
    case 'start-recording':
      startRecordingForToken(panelState.selectedToken);
      break;
    case 'stop-recording':
      stopActiveRecording();
      break;
    case 'play-assigned':
      if (panelState.selectedToken) playAssignedForToken(panelState.selectedToken);
      break;
    case 'play-tts':
      playTokenTts(panelState.selectedToken);
      break;
    case 'play-recording':
      playRecordingById(recordingId);
      break;
    case 'set-profile':
      setProfileRecording(recordingId);
      break;
    case 'delete-recording':
      deleteRecording(recordingId);
      break;
    case 'save-tags': {
      const input = elements.detail?.querySelector(`.voice-tag-input[data-recording-id="${cssEscape(recordingId)}"]`);
      if (input) updateRecordingTags(recordingId, input.value);
      break;
    }
    case 'apply-assignment': {
      const textarea = elements.detail?.querySelector(`.voice-assignment-input[data-recording-id="${cssEscape(recordingId)}"]`);
      if (textarea) assignRecordingToTokens(recordingId, textarea.value);
      break;
    }
    case 'select-recording':
      panelState.selectedRecordingId = recordingId;
      renderTokenDetail();
      break;
    default:
      break;
  }
}

function handleDetailInput(event) {
  const target = event.target;
  if (!target?.dataset) return;
  const role = target.dataset.role;
  if (!role) return;
  const value = Number(target.value);
  switch (role) {
    case 'voice-pitch':
      store.voicePreferences.pitch = Number.isFinite(value) ? Math.max(0.5, Math.min(2, value)) : 1;
      updateVoicePreferenceDisplay('pitch', store.voicePreferences.pitch);
      saveVoiceStore();
      break;
    case 'voice-rate':
      store.voicePreferences.rate = Number.isFinite(value) ? Math.max(0.5, Math.min(2.5, value)) : 1;
      updateVoicePreferenceDisplay('rate', store.voicePreferences.rate);
      saveVoiceStore();
      break;
    case 'voice-volume':
      store.voicePreferences.volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
      updateVoicePreferenceDisplay('volume', store.voicePreferences.volume);
      saveVoiceStore();
      break;
    case 'voice-select':
      store.voicePreferences.voiceURI = target.value || '';
      saveVoiceStore();
      break;
    default:
      break;
  }
}

function updateVoicePreferenceDisplay(type, value) {
  if (!elements.detail) return;
  const span = elements.detail.querySelector(`[data-role="voice-${type}-display"]`);
  if (span) span.textContent = Number(value).toFixed(2);
}

async function startRecordingForToken(token) {
  if (!token) {
    setStatus('Select a token before recording.', 'warning');
    return;
  }
  if (panelState.isRecording) {
    setStatus('Recording already in progress.', 'warning');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Microphone access is not supported in this browser.', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const transcriptParts = [];
    const recognition = startSpeechRecognition(transcriptParts);
    panelState.isRecording = true;
    panelState.activeTranscript = '';
    activeRecorder = { recorder, stream, chunks, token, transcriptParts, recognition };
    recorder.ondataavailable = evt => {
      if (evt.data?.size > 0) chunks.push(evt.data);
    };
    recorder.onstop = () => finalizeRecording(activeRecorder);
    recorder.start();
    setStatus('Recording started. Speak the token and any expressive samples you want captured.', 'info');
    renderTokenDetail();
  } catch (err) {
    console.warn('Unable to start microphone recording:', err);
    setStatus('Microphone access denied or unavailable.', 'error');
  }
}

function startSpeechRecognition(parts) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  try {
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = event => {
      let changed = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal && result[0]) {
          parts.push(result[0].transcript.trim());
          changed = true;
        }
      }
      if (changed) {
        panelState.activeTranscript = parts.join(' ');
        updateLiveTranscript();
      }
    };
    recognition.onerror = err => {
      console.warn('Speech recognition error:', err);
    };
    recognition.start();
    return recognition;
  } catch (err) {
    console.warn('Failed to start speech recognition:', err);
    return null;
  }
}

function updateLiveTranscript() {
  if (!elements.detail) return;
  const el = elements.detail.querySelector('[data-role="live-transcript"]');
  if (el) el.textContent = panelState.activeTranscript || 'Listening…';
}

function stopActiveRecording() {
  if (!activeRecorder) return;
  try { activeRecorder.recorder.stop(); } catch {}
  if (activeRecorder.recognition) {
    try { activeRecorder.recognition.stop(); } catch {}
  }
}

async function finalizeRecording(session) {
  if (!session) return;
  panelState.isRecording = false;
  const { recorder, stream, chunks, token, transcriptParts } = session;
  activeRecorder = null;
  if (stream) {
    try {
      for (const track of stream.getTracks()) track.stop();
    } catch {}
  }
  if (!chunks.length) {
    setStatus('Recording ended but no audio was captured.', 'warning');
    renderTokenDetail();
    return;
  }
  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
  setStatus('Processing recording…', 'info');
  try {
    const base64 = await blobToBase64(blob);
    const newRecording = {
      id: generateRecordingId(),
      token,
      createdAt: new Date().toISOString(),
      audioBase64: base64,
      audioType: blob.type || 'audio/webm',
      transcript: transcriptParts.join(' ').trim() || token,
      tags: [],
      iteration: (recordingIndex.get(token)?.[0]?.iteration || recordingIndex.get(token)?.length || 0) + 1,
      sourceToken: token,
    };
    store.recordings.push(newRecording);
    store.assignments[token] = newRecording.id;
    if (!store.profileRecordingId) {
      store.profileRecordingId = newRecording.id;
    }
    saveVoiceStore();
    recordingIndex = buildRecordingIndex();
    setStatus('Recording saved and mapped to token.', 'success');
    selectToken(token);
    signalVoiceCloneTokensChanged('recording-added');
  } catch (err) {
    console.warn('Failed to process recording:', err);
    setStatus('Unable to save the recording. Try again.', 'error');
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (typeof data === 'string') {
        const base64 = data.split(',')[1] || '';
        resolve(base64);
      } else {
        reject(new Error('Unexpected FileReader result.'));
      }
    };
    reader.onerror = err => reject(err);
    reader.readAsDataURL(blob);
  });
}

function generateRecordingId() {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function updateRecordingTags(recordingId, value) {
  if (!recordingId) return;
  const recording = store.recordings.find(rec => rec.id === recordingId);
  if (!recording) return;
  const tags = (value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
  recording.tags = tags;
  saveVoiceStore();
  setStatus('Tags updated.', 'success');
  renderTokenDetail();
}

function assignRecordingToTokens(recordingId, value) {
  if (!recordingId) return;
  const tokens = (value || '')
    .split(/[\n,]/)
    .map(token => token.trim())
    .filter(Boolean);
  const nextAssignments = new Set(tokens);
  for (const [token, assigned] of Object.entries(store.assignments || {})) {
    if (assigned === recordingId && !nextAssignments.has(token)) {
      delete store.assignments[token];
    }
  }
  for (const token of nextAssignments) {
    store.assignments[token] = recordingId;
  }
  saveVoiceStore();
  setStatus('Voice mapping updated.', 'success');
  signalVoiceCloneTokensChanged('assignment-updated');
  renderTokenDetail();
  renderTokenList();
}

function setProfileRecording(recordingId) {
  if (!recordingId) return;
  if (!store.recordings.find(rec => rec.id === recordingId)) {
    setStatus('Recording not found.', 'error');
    return;
  }
  store.profileRecordingId = recordingId;
  saveVoiceStore();
  setStatus('Voice profile updated.', 'success');
  renderTokenDetail();
}

function deleteRecording(recordingId) {
  if (!recordingId) return;
  const idx = store.recordings.findIndex(rec => rec.id === recordingId);
  if (idx === -1) return;
  if (!window.confirm('Delete this recording? This action cannot be undone.')) return;
  store.recordings.splice(idx, 1);
  for (const [token, assigned] of Object.entries(store.assignments || {})) {
    if (assigned === recordingId) delete store.assignments[token];
  }
  if (store.profileRecordingId === recordingId) {
    store.profileRecordingId = null;
  }
  saveVoiceStore();
  recordingIndex = buildRecordingIndex();
  setStatus('Recording removed.', 'warning');
  renderTokenDetail();
  renderTokenList();
}

function handleSearchInput(event) {
  panelState.filter = event.target.value || '';
  renderTokenList();
}

function signalVoiceCloneTokensChanged(reason = 'unknown') {
  pendingTokenRefresh = true;
  try {
    if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(TOKENS_CHANGED_EVENT, { detail: { reason } }));
    }
  } catch {
    // ignore dispatch errors
  }
  if (panelReady) {
    refreshTokens();
  }
}

function handleTokensChanged() {
  refreshTokens();
}

function initializeVoiceClonePanel() {
  if (panelReady) return;
  store = loadVoiceStore();
  elements.panel = document.getElementById('voice-clone-panel');
  elements.tokenList = document.getElementById('voice-token-list');
  elements.detail = document.getElementById('voice-token-detail');
  elements.search = document.getElementById('voice-token-search');
  elements.refresh = document.getElementById('voice-token-refresh');
  elements.status = document.getElementById('voice-clone-status');
  if (!elements.panel) return;

  panelReady = true;
  recordingIndex = buildRecordingIndex();

  elements.search?.addEventListener('input', handleSearchInput);
  elements.refresh?.addEventListener('click', () => refreshTokens());
  elements.tokenList?.addEventListener('click', handleTokenListClick);
  elements.detail?.addEventListener('click', handleDetailClick);
  elements.detail?.addEventListener('input', handleDetailInput);

  if (typeof window.addEventListener === 'function') {
    window.addEventListener(TOKENS_CHANGED_EVENT, handleTokensChanged);
    window.addEventListener(DATABASE_READY_EVENT, handleTokensChanged);
  }

  refreshTokens();
  if (pendingTokenRefresh) {
    refreshTokens();
    pendingTokenRefresh = false;
  }

  window.CognitionEngine = window.CognitionEngine || {};
  window.CognitionEngine.voice = Object.assign({}, window.CognitionEngine.voice || {}, {
    getStore: () => JSON.parse(JSON.stringify(store)),
    refreshTokens,
    playToken: playAssignedForToken,
    playTts: playTokenTts,
    signalTokensChanged: signalVoiceCloneTokensChanged,
  });
}

export { initializeVoiceClonePanel, signalVoiceCloneTokensChanged };
