// @ts-nocheck

const STORAGE_KEY = 'HLSF_VOICE_CLONE_STATE_V1';
const PROFILE_CLONE_WORD_THRESHOLD = 100;
const TOKENS_CHANGED_EVENT = 'voice:tokens-changed';
const DATABASE_READY_EVENT = 'hlsf:database-ready';
const MAX_RENDERED_TOKENS = 800;
const PROFILE_SYNTHESIS_TOKEN_THRESHOLD = 100;

function defaultVoicePreferences() {
  return {
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
  };
}

function defaultProfileSynthesis() {
  return {
    available: false,
    synthesizedAt: null,
    tokenCount: 0,
  };
}

function defaultVoiceStore() {
  return {
    recordings: [],
    assignments: {},
    profileRecordingId: null,
    voicePreferences: defaultVoicePreferences(),
    profileClone: null,
    profileSynthesis: defaultProfileSynthesis(),
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
let sessionVoiceApplied = false;

function countWords(text) {
  if (!text) return 0;
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function getTotalTranscriptWords() {
  let total = 0;
  for (const recording of store.recordings || []) {
    total += countWords(recording?.transcript || recording?.token || '');
  }
  return total;
}

function buildCloneDivergence() {
  const map = {};
  for (const recording of store.recordings || []) {
    const tags = Array.isArray(recording?.tags) ? recording.tags : [];
    if (!tags.length) continue;
    const tokenList = listTokensForRecording(recording.id);
    for (const tag of tags) {
      const key = typeof tag === 'string' ? tag.trim() : '';
      if (!key) continue;
      if (!map[key]) map[key] = [];
      map[key].push({
        recordingId: recording.id,
        token: recording.token || '',
        transcript: recording.transcript || '',
        iteration: recording.iteration || 1,
        tokens: tokenList,
      });
    }
  }
  return map;
}

function generateCloneId() {
  return `clone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function refreshVoiceProfileClone(persist = false) {
  const clone = store.profileClone;
  if (!clone) return;
  const hasRecording = store.recordings.some(rec => rec.id === clone.recordingId);
  if (!hasRecording) {
    store.profileClone = null;
    saveVoiceStore();
    return;
  }
  clone.wordCount = getTotalTranscriptWords();
  clone.divergenceMap = buildCloneDivergence();
  if (persist) saveVoiceStore();
}

function getValidProfileClone() {
  const clone = store.profileClone;
  if (!clone) return null;
  const hasRecording = store.recordings.some(rec => rec.id === clone.recordingId);
  if (!hasRecording) return null;
  return clone;
}

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
    if (parsed?.profileClone && typeof parsed.profileClone === 'object') {
      normalized.profileClone = normalizeProfileClone(parsed.profileClone);
    }
    if (normalized.profileClone && normalized.profileClone.recordingId) {
      const exists = normalized.recordings.some(rec => rec.id === normalized.profileClone.recordingId);
      if (!exists) normalized.profileClone = null;
    }
    normalized.profileSynthesis = normalizeProfileSynthesis(parsed?.profileSynthesis);
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

function normalizeProfileClone(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const recordingId = typeof entry.recordingId === 'string' ? entry.recordingId : null;
  if (!recordingId) return null;
  const id = typeof entry.id === 'string' && entry.id ? entry.id : `clone_${Date.now().toString(36)}`;
  const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString();
  const wordCount = Number.isFinite(entry.wordCount) ? Math.max(0, Math.floor(entry.wordCount)) : 0;
  const attached = entry.attached !== false;
  const divergenceMap = {};
  if (entry.divergenceMap && typeof entry.divergenceMap === 'object') {
    for (const [tag, list] of Object.entries(entry.divergenceMap)) {
      if (!Array.isArray(list) || !tag) continue;
      const normalizedList = list
        .map(item => {
          if (!item || typeof item !== 'object') return null;
          const recId = typeof item.recordingId === 'string' ? item.recordingId : null;
          if (!recId) return null;
          const token = typeof item.token === 'string' ? item.token : '';
          const transcript = typeof item.transcript === 'string' ? item.transcript : '';
          const iteration = Number.isFinite(item.iteration) ? Number(item.iteration) : 1;
          const tokens = Array.isArray(item.tokens) ? item.tokens.filter(Boolean).map(String) : [];
          return { recordingId: recId, token, transcript, iteration, tokens };
        })
        .filter(Boolean);
      if (normalizedList.length) divergenceMap[tag] = normalizedList;
    }
  }
  return {
    id,
    recordingId,
    createdAt,
    wordCount,
    attached,
    divergenceMap,
  };
}

function normalizeProfileSynthesis(entry) {
  const state = defaultProfileSynthesis();
  if (!entry || typeof entry !== 'object') return state;
  state.available = entry.available === true;
  state.tokenCount = Number.isFinite(entry.tokenCount) ? Math.max(0, Math.floor(entry.tokenCount)) : 0;
  state.synthesizedAt = typeof entry.synthesizedAt === 'string' ? entry.synthesizedAt : null;
  return state;
}

function saveVoiceStore() {
  try {
    const payload = JSON.stringify(store);
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (err) {
    console.warn('Unable to persist voice clone store:', err);
  }
}

function getMappedTokenCount() {
  let count = 0;
  const assignments = store.assignments || {};
  const validIds = new Set((store.recordings || []).map(rec => rec.id));
  for (const [token, recordingId] of Object.entries(assignments)) {
    if (!token || typeof token !== 'string') continue;
    if (!recordingId || !validIds.has(recordingId)) continue;
    count += 1;
  }
  return count;
}

function hasSynthesizedVoiceProfile() {
  const synthesis = store.profileSynthesis;
  if (!synthesis || synthesis.available !== true) return false;
  return Boolean(getValidProfileClone());
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
  refreshVoiceProfileClone(false);
  const filter = panelState.filter.trim().toLowerCase();
  const tokenStats = new Map();
  for (const [token, list] of recordingIndex) {
    tokenStats.set(token, list.length);
  }
  const clone = getValidProfileClone();
  const usingSynthesizedPreview = hasSynthesizedVoiceProfile();
  const items = [];
  let rendered = 0;
  for (const token of panelState.tokens) {
    if (filter && !token.toLowerCase().includes(filter)) continue;
    rendered += 1;
    if (rendered > MAX_RENDERED_TOKENS) break;
    const assignedId = store.assignments?.[token] || null;
    const recordings = tokenStats.get(token) || 0;
    const hasAssigned = Boolean(assignedId);
    const usingClone = !hasAssigned && Boolean(clone);
    const statusLabel = hasAssigned
      ? 'Voice mapped'
      : recordings > 0
        ? `${recordings} recording${recordings === 1 ? '' : 's'}`
        : usingClone
          ? 'Cloned profile available'
          : 'No voice data';
    const disabledAssigned = hasAssigned || usingClone ? '' : 'disabled';
    const disabledTts = !usingSynthesizedPreview && typeof window.speechSynthesis === 'undefined' ? 'disabled' : '';
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

function renderProfileCloneSection(contextToken = null) {
  refreshVoiceProfileClone(false);
  const totalWords = getTotalTranscriptWords();
  const clone = getValidProfileClone();
  const hasProfileRecording = Boolean(
    store.profileRecordingId && store.recordings.some(rec => rec.id === store.profileRecordingId)
  );
  const canClone = hasProfileRecording && totalWords >= PROFILE_CLONE_WORD_THRESHOLD;
  const wordsRemaining = Math.max(0, PROFILE_CLONE_WORD_THRESHOLD - totalWords);
  const mappedTokens = getMappedTokenCount();
  const synthesisState = store.profileSynthesis || defaultProfileSynthesis();
  const synthesisTokensRemaining = Math.max(0, PROFILE_SYNTHESIS_TOKEN_THRESHOLD - mappedTokens);
  const canSynthesize = mappedTokens >= PROFILE_SYNTHESIS_TOKEN_THRESHOLD;
  let requirementMessage = '';
  if (!hasProfileRecording) {
    requirementMessage = 'Set a recording as your voice profile to unlock cloning.';
  } else if (clone) {
    requirementMessage = canClone
      ? 'Re-clone to capture your latest recordings or tag adjustments.'
      : 'Voice clone ready. Capture more speech to refresh when you have new material.';
  } else if (canClone) {
    requirementMessage = 'You have enough captured speech to clone your voice profile.';
  } else {
    requirementMessage = `Record ${wordsRemaining} more word${wordsRemaining === 1 ? '' : 's'} to unlock cloning.`;
  }

  const synthesisRequirementMessage = canSynthesize
    ? synthesisState?.available
      ? 'Re-synthesize your mapped tokens whenever you capture new material to refresh the generated preview.'
      : 'Synthesize your mapped tokens to enable the generated preview on every token.'
    : `Map ${synthesisTokensRemaining} more token${synthesisTokensRemaining === 1 ? '' : 's'} to unlock synthesis.`;

  const buttonLabel = clone ? 'Re-clone voice profile' : 'Clone voice profile';
  const cloneButtonDisabled = canClone ? '' : 'disabled';
  const previewDisabled = clone ? '' : 'disabled';
  const attachDisabled = clone ? '' : 'disabled';
  const attachLabel = clone?.attached ? 'Detach from HLSF export' : 'Attach to HLSF export';
  const tokenAttr = contextToken ? ` data-token="${escapeAttr(contextToken)}"` : '';
  const synthesisButtonDisabled = canSynthesize ? '' : 'disabled';

  const summaryParts = [
    `<div><strong>Captured words:</strong> ${escapeHtml(String(totalWords))}</div>`,
    `<div><strong>Tokens mapped:</strong> ${escapeHtml(String(mappedTokens))} / ${PROFILE_SYNTHESIS_TOKEN_THRESHOLD}</div>`,
  ];
  if (clone) {
    const created = clone.createdAt && !Number.isNaN(Date.parse(clone.createdAt))
      ? new Date(clone.createdAt).toLocaleString()
      : '';
    if (created) {
      summaryParts.push(`<div><strong>Cloned:</strong> ${escapeHtml(created)}</div>`);
    }
    summaryParts.push(`<div><strong>Offline export:</strong> ${escapeHtml(clone.attached ? 'Attached' : 'Detached')}</div>`);
  }
  if (synthesisState?.available && clone) {
    const synthesized = synthesisState.synthesizedAt && !Number.isNaN(Date.parse(synthesisState.synthesizedAt))
      ? new Date(synthesisState.synthesizedAt).toLocaleString()
      : 'Ready';
    summaryParts.push(
      `<div><strong>Synthesized:</strong> ${escapeHtml(synthesized)} (${escapeHtml(String(synthesisState.tokenCount || 0))} tokens)</div>`
    );
  }

  let divergenceMarkup = '';
  if (clone) {
    const entries = Object.entries(clone.divergenceMap || {});
    if (entries.length) {
      const listItems = entries
        .map(([tag, items]) => {
          if (!Array.isArray(items) || !tag) return '';
          const details = items
            .map(item => {
              if (!item || typeof item !== 'object') return '';
              const tokens = Array.isArray(item.tokens) && item.tokens.length ? item.tokens.join(', ') : '';
              if (tokens) return escapeHtml(tokens);
              if (item.token) return escapeHtml(item.token);
              if (item.transcript) return escapeHtml(item.transcript);
              return '';
            })
            .filter(Boolean)
            .join('; ');
          const descriptor = details ? ` – ${details}` : '';
          return `<li><strong>${escapeHtml(tag)}</strong>${descriptor}</li>`;
        })
        .filter(Boolean)
        .join('');
      divergenceMarkup = `
        <div class="voice-clone-divergence">
          <strong>Emotional divergence tags</strong>
          <ul>${listItems}</ul>
        </div>`;
    } else {
      divergenceMarkup = `
        <div class="voice-clone-divergence">
          <strong>Emotional divergence tags</strong>
          <p class="voice-clone-empty">No tagged recordings yet.</p>
        </div>`;
    }
  }

  return `
    <section class="voice-profile-clone">
      <div class="voice-clone-heading"><strong>Voice profile cloning</strong></div>
      <div class="voice-clone-summary">
        ${summaryParts.join('')}
      </div>
      <p class="voice-clone-requirement">${escapeHtml(requirementMessage)}</p>
      <p class="voice-clone-requirement">${escapeHtml(synthesisRequirementMessage)}</p>
      <div class="voice-clone-actions">
        <button type="button" data-action="clone-profile" ${cloneButtonDisabled}>${escapeHtml(buttonLabel)}</button>
        <button type="button" data-action="synthesize-profile" ${synthesisButtonDisabled}>Synthesize voice profile</button>
        <button type="button" data-action="play-clone"${tokenAttr} ${previewDisabled}>Preview cloned profile</button>
        <button type="button" data-action="toggle-clone-attachment" ${attachDisabled}>${escapeHtml(attachLabel)}</button>
      </div>
      ${divergenceMarkup}
    </section>
  `;
}

function renderTokenDetail() {
  if (!elements.detail) return;
  const token = panelState.selectedToken;
  if (!token) {
    const profileSection = renderProfileCloneSection();
    elements.detail.innerHTML = `
      <p class="voice-detail-placeholder">Select a cache token to begin recording and mapping your voice profile.</p>
      ${profileSection}
    `;
    setStatus('', 'info');
    return;
  }
  const recordings = recordingIndex.get(token) || [];
  const assignedId = store.assignments?.[token] || null;
  const assignedRecording = assignedId ? store.recordings.find(rec => rec.id === assignedId) : null;
  const clone = getValidProfileClone();
  const recCount = recordings.length;
  const recordingLabel = recCount === 1 ? '1 recording' : `${recCount} recordings`;
  const usingSynthPreview = hasSynthesizedVoiceProfile();
  const ttsDisabled = !usingSynthPreview && typeof window.speechSynthesis === 'undefined';
  const assignedMarkup = assignedRecording
    ? renderAssignedBlock(assignedRecording)
    : '<div class="voice-assigned-block"><em>No voice mapped to this token yet.</em></div>';
  const recordingsMarkup = recordings.length
    ? `<div class="voice-recordings-list">${recordings.map(renderRecordingCard).join('')}</div>`
    : '<div class="voice-recordings-list"><div class="voice-recording-card"><em>No recordings captured for this token yet.</em></div></div>';

  const voicePrefs = store.voicePreferences || defaultVoicePreferences();
  const recordBtnLabel = panelState.isRecording ? 'Recording…' : 'Record new iteration';
  const stopButton = panelState.isRecording ? '<button type="button" data-action="stop-recording">Stop recording</button>' : '';
  const assignedButtonLabel = assignedRecording ? 'Play assigned voice' : clone ? 'Play cloned voice' : 'Play assigned voice';
  const ttsButtonLabel = usingSynthPreview ? 'Play synthesized preview' : 'Play TTS preview';

  const profileSection = renderProfileCloneSection(token);
  elements.detail.innerHTML = `
    <div class="voice-detail-header">
      <h3>${escapeHtml(token)}</h3>
      <span class="voice-iteration-count">${escapeHtml(recordingLabel)}</span>
    </div>
    <div class="voice-detail-actions">
      <button type="button" data-action="start-recording" ${panelState.isRecording ? 'disabled' : ''}>${escapeHtml(recordBtnLabel)}</button>
      ${stopButton}
      <button type="button" data-action="play-assigned" ${assignedRecording || clone ? '' : 'disabled'} data-recording-id="${assignedRecording ? escapeAttr(assignedRecording.id) : ''}">${escapeHtml(assignedButtonLabel)}</button>
      <button type="button" data-action="play-tts" ${ttsDisabled ? 'disabled' : ''}>${escapeHtml(ttsButtonLabel)}</button>
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
    ${profileSection}
    ${assignedMarkup}
    ${recordingsMarkup}
  `;

  populateVoiceSelect();
  setStatus(panelState.status?.message || '', panelState.status?.type || 'info');
}

function cloneVoiceProfile() {
  const profileId = store.profileRecordingId;
  if (!profileId) {
    setStatus('Set a recording as the voice profile before cloning.', 'warning');
    return;
  }
  const profileRecording = store.recordings.find(rec => rec.id === profileId);
  if (!profileRecording) {
    setStatus('Voice profile recording is missing. Select a valid recording first.', 'error');
    return;
  }
  const totalWords = getTotalTranscriptWords();
  if (totalWords < PROFILE_CLONE_WORD_THRESHOLD) {
    const needed = PROFILE_CLONE_WORD_THRESHOLD - totalWords;
    setStatus(`Record ${needed} more word${needed === 1 ? '' : 's'} before cloning your voice profile.`, 'warning');
    return;
  }
  const previouslyAttached = store.profileClone ? store.profileClone.attached !== false : true;
  const clone = {
    id: store.profileClone?.id || generateCloneId(),
    recordingId: profileRecording.id,
    createdAt: new Date().toISOString(),
    wordCount: totalWords,
    attached: previouslyAttached,
    divergenceMap: buildCloneDivergence(),
  };
  store.profileClone = clone;
  saveVoiceStore();
  setStatus('Voice profile cloned. Preview it on any token or attach it to offline exports.', 'success');
  renderTokenList();
  renderTokenDetail();
}

function synthesizeVoiceProfile() {
  const mappedTokens = getMappedTokenCount();
  if (mappedTokens < PROFILE_SYNTHESIS_TOKEN_THRESHOLD) {
    const needed = PROFILE_SYNTHESIS_TOKEN_THRESHOLD - mappedTokens;
    setStatus(`Map ${needed} more token${needed === 1 ? '' : 's'} before synthesizing your voice profile.`, 'warning');
    return;
  }
  const clone = getValidProfileClone();
  if (!clone) {
    setStatus('Clone your voice profile before synthesizing it.', 'warning');
    return;
  }
  store.profileSynthesis = {
    available: true,
    synthesizedAt: new Date().toISOString(),
    tokenCount: mappedTokens,
  };
  saveVoiceStore();
  setStatus('Voice profile synthesized. TTS preview now uses the generated voice.', 'success');
  renderTokenList();
  renderTokenDetail();
}

function toggleProfileCloneAttachment() {
  const clone = getValidProfileClone();
  if (!clone) {
    setStatus('Clone your voice profile before toggling offline export.', 'warning');
    return;
  }
  clone.attached = !clone.attached;
  saveVoiceStore();
  setStatus(
    clone.attached
      ? 'Voice profile clone will be attached to offline HLSF exports.'
      : 'Voice profile clone detached from offline exports.',
    'info'
  );
  renderTokenDetail();
}

function playProfileClone(token) {
  const clone = getValidProfileClone();
  if (!clone) {
    setStatus('Clone your voice profile to enable this preview.', 'warning');
    return;
  }
  const recording = store.recordings.find(rec => rec.id === clone.recordingId);
  if (!recording) {
    store.profileClone = null;
    saveVoiceStore();
    setStatus('Voice profile clone is missing its source recording. Create a new clone.', 'error');
    renderTokenDetail();
    renderTokenList();
    return;
  }
  if (activePlayback) {
    try { activePlayback.pause(); } catch {}
    activePlayback = null;
  }
  const audio = new Audio(getRecordingUrl(recording));
  audio.play().catch(err => console.warn('Failed to play voice profile clone:', err));
  activePlayback = audio;
  const suffix = token ? ` for ${token}` : '';
  setStatus(`Playing voice profile clone${suffix}.`, 'info');
}

function getProfileCloneExportPayload(options = {}) {
  const { requireAttachment = true } = options || {};
  refreshVoiceProfileClone(false);
  const clone = getValidProfileClone();
  if (!clone) return null;
  if (requireAttachment && clone.attached === false) return null;
  const recording = store.recordings.find(rec => rec.id === clone.recordingId);
  if (!recording) return null;
  const divergence = clone.divergenceMap ? JSON.parse(JSON.stringify(clone.divergenceMap)) : {};
  return {
    id: clone.id,
    recordingId: recording.id,
    createdAt: clone.createdAt,
    wordCount: clone.wordCount,
    divergenceMap: divergence,
    attached: clone.attached !== false,
    recording: {
      id: recording.id,
      token: recording.token,
      transcript: recording.transcript,
      tags: Array.isArray(recording.tags) ? recording.tags.slice() : [],
      tokens: listTokensForRecording(recording.id),
      audioBase64: recording.audioBase64,
      audioType: recording.audioType || 'audio/webm',
    },
  };
}

function getVoiceProfileExportPayload() {
  const recordings = Array.isArray(store.recordings) ? store.recordings : [];
  if (!recordings.length) return null;

  const normalizedRecordings = [];
  const recordingIds = new Set();
  for (const recording of recordings) {
    if (!recording?.id || !recording.token) continue;
    recordingIds.add(recording.id);
    normalizedRecordings.push({
      id: recording.id,
      token: recording.token,
      createdAt: recording.createdAt,
      transcript: recording.transcript,
      tags: Array.isArray(recording.tags) ? recording.tags.slice() : [],
      iteration: Number.isFinite(recording.iteration) ? recording.iteration : 1,
      sourceToken: recording.sourceToken || recording.token,
      audioBase64: recording.audioBase64 || '',
      audioType: recording.audioType || 'audio/webm',
    });
  }

  if (!normalizedRecordings.length) return null;

  const assignments = {};
  for (const [token, recId] of Object.entries(store.assignments || {})) {
    if (!token || typeof recId !== 'string') continue;
    if (!recordingIds.has(recId)) continue;
    assignments[token] = recId;
  }

  const clonePayload = getProfileCloneExportPayload({ requireAttachment: false });
  const voicePreferences = Object.assign(defaultVoicePreferences(), store.voicePreferences || {});

  const preferredProfileId = recordingIds.has(store.profileRecordingId)
    ? store.profileRecordingId
    : (clonePayload?.recording?.id && recordingIds.has(clonePayload.recording.id))
      ? clonePayload.recording.id
      : null;

  return {
    version: 1,
    recordings: normalizedRecordings,
    assignments,
    profileRecordingId: preferredProfileId,
    voicePreferences,
    profileClone: clonePayload,
  };
}

function normalizeVoiceProfilePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const normalizedStore = defaultVoiceStore();
  const recordingMap = new Map();

  const addRecording = entry => {
    if (!entry) return;
    const candidate = Object.assign({}, entry);
    if (payload.profileClone && payload.profileClone.recording === entry) {
      candidate.id = payload.profileClone.recordingId || entry.id;
    }
    const normalized = normalizeRecording(candidate);
    if (!normalized) return;
    recordingMap.set(normalized.id, normalized);
  };

  if (Array.isArray(payload.recordings)) {
    for (const rec of payload.recordings) {
      addRecording(rec);
    }
  }

  const cloneSource = payload.profileClone && typeof payload.profileClone === 'object'
    ? payload.profileClone
    : null;
  let normalizedClone = null;
  if (cloneSource) {
    const cloneCandidate = Object.assign({}, cloneSource);
    if (!cloneCandidate.recordingId && cloneCandidate.recording && typeof cloneCandidate.recording.id === 'string') {
      cloneCandidate.recordingId = cloneCandidate.recording.id;
    }
    normalizedClone = normalizeProfileClone(cloneCandidate);
    if (normalizedClone?.recordingId) {
      const cloneRecording = cloneSource.recording && typeof cloneSource.recording === 'object'
        ? Object.assign({ id: normalizedClone.recordingId }, cloneSource.recording)
        : null;
      if (cloneRecording) addRecording(cloneRecording);
    }
  }

  if (!recordingMap.size) return null;

  const sortedRecordings = Array.from(recordingMap.values()).sort((a, b) => {
    const timeA = Date.parse(a.createdAt) || 0;
    const timeB = Date.parse(b.createdAt) || 0;
    return timeB - timeA;
  });
  normalizedStore.recordings = sortedRecordings;

  const assignments = {};
  if (payload.assignments && typeof payload.assignments === 'object') {
    for (const [token, recId] of Object.entries(payload.assignments)) {
      if (!token || typeof recId !== 'string') continue;
      if (!recordingMap.has(recId)) continue;
      assignments[token] = recId;
    }
  }
  normalizedStore.assignments = assignments;

  if (payload.voicePreferences && typeof payload.voicePreferences === 'object') {
    normalizedStore.voicePreferences = Object.assign(
      defaultVoicePreferences(),
      payload.voicePreferences,
    );
  }

  let profileRecordingId = typeof payload.profileRecordingId === 'string'
    ? payload.profileRecordingId
    : null;
  if (!profileRecordingId || !recordingMap.has(profileRecordingId)) {
    if (normalizedClone && recordingMap.has(normalizedClone.recordingId)) {
      profileRecordingId = normalizedClone.recordingId;
    } else {
      profileRecordingId = null;
    }
  }
  normalizedStore.profileRecordingId = profileRecordingId;

  if (normalizedClone && recordingMap.has(normalizedClone.recordingId)) {
    normalizedStore.profileClone = Object.assign({}, normalizedClone, { attached: normalizedClone.attached !== false });
  }

  return normalizedStore;
}

function importVoiceProfileExportPayload(payload, options = {}) {
  const { persist = true, source = 'manual' } = options || {};
  const normalized = normalizeVoiceProfilePayload(payload);
  if (!normalized) return false;

  store = normalized;
  audioUrlCache.clear();
  recordingIndex = buildRecordingIndex();
  refreshVoiceProfileClone(false);
  if (persist) saveVoiceStore();
  signalVoiceCloneTokensChanged('voice-profile-import');
  if (panelReady) {
    renderTokenList();
    renderTokenDetail();
    const message = source === 'session'
      ? 'Voice profile imported from session.'
      : 'Voice profile imported.';
    setStatus(message, 'success');
  }
  return true;
}

function maybeImportVoiceProfileFromSession() {
  if (sessionVoiceApplied) return;
  const session = window.Session;
  if (!session || typeof session !== 'object') return;

  let payload = null;
  if (session.voiceProfile && typeof session.voiceProfile === 'object') {
    payload = session.voiceProfile;
  } else if (session.voiceProfileClone && typeof session.voiceProfileClone === 'object') {
    const cloneOnly = session.voiceProfileClone;
    payload = { profileClone: cloneOnly };
    if (cloneOnly.recording && typeof cloneOnly.recording === 'object') {
      payload.recordings = [Object.assign({}, cloneOnly.recording)];
    }
  }

  if (!payload) return;
  const imported = importVoiceProfileExportPayload(payload, { source: 'session', persist: true });
  if (imported) sessionVoiceApplied = true;
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
    if (getValidProfileClone()) {
      playProfileClone(token);
    } else {
      setStatus('No voice has been assigned to this token yet.', 'warning');
    }
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
  if (hasSynthesizedVoiceProfile()) {
    playProfileClone(token);
    setStatus('Playing synthesized voice profile preview.', 'info');
    return;
  }
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
    case 'synthesize-profile':
      synthesizeVoiceProfile();
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
    case 'clone-profile':
      cloneVoiceProfile();
      break;
    case 'toggle-clone-attachment':
      toggleProfileCloneAttachment();
      break;
    case 'play-clone': {
      const targetToken = target.dataset.token || panelState.selectedToken || '';
      playProfileClone(targetToken || null);
      break;
    }
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
    refreshVoiceProfileClone(false);
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
  refreshVoiceProfileClone(false);
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
  refreshVoiceProfileClone(false);
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
  let statusMessage = 'Voice profile updated.';
  let statusType = 'success';
  if (store.profileClone && store.profileClone.recordingId !== recordingId) {
    store.profileClone = null;
    statusMessage = 'Voice profile updated. Existing clone cleared; create a new clone to refresh offline previews.';
    statusType = 'info';
  }
  refreshVoiceProfileClone(false);
  saveVoiceStore();
  setStatus(statusMessage, statusType);
  renderTokenDetail();
}

function deleteRecording(recordingId) {
  if (!recordingId) return;
  const idx = store.recordings.findIndex(rec => rec.id === recordingId);
  if (idx === -1) return;
  if (!window.confirm('Delete this recording? This action cannot be undone.')) return;
  const wasCloneSource = store.profileClone?.recordingId === recordingId;
  store.recordings.splice(idx, 1);
  for (const [token, assigned] of Object.entries(store.assignments || {})) {
    if (assigned === recordingId) delete store.assignments[token];
  }
  if (store.profileRecordingId === recordingId) {
    store.profileRecordingId = null;
  }
  refreshVoiceProfileClone(false);
  saveVoiceStore();
  recordingIndex = buildRecordingIndex();
  const message = wasCloneSource
    ? 'Recording removed. Voice profile clone cleared.'
    : 'Recording removed.';
  setStatus(message, 'warning');
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
  maybeImportVoiceProfileFromSession();
  refreshVoiceProfileClone(false);
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
    getProfileClone: getProfileCloneExportPayload,
    getProfileExport: getVoiceProfileExportPayload,
    importProfile: importVoiceProfileExportPayload,
  });
}

export { initializeVoiceClonePanel, signalVoiceCloneTokensChanged };
