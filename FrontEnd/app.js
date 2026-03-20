/* =============================================
   BRADLEY v3 — Frontend
   frontend/app.js
   Communique avec le backend Express + RAG
   ============================================= */

// ===========================
// CONFIGURATION
// ===========================
const API_BASE = 'http://localhost:3000/api';

// ===========================
// STATE
// ===========================
let state = {
  currentConvId:   null,
  conversations:   JSON.parse(localStorage.getItem('bradley_conversations') || '{}'),
  history:         [],
  memory:          JSON.parse(localStorage.getItem('bradley_memory') || '[]'),
  settings:        JSON.parse(localStorage.getItem('bradley_settings') || '{}'),
  isLoading:       false,
  abortController: null,
  sidebarOpen:     localStorage.getItem('bradley_sidebar') !== 'false',
  tokenCount:      0,
};

// ===========================
// INIT
// ===========================
document.addEventListener('DOMContentLoaded', async () => {
  loadSettings();
  renderConversationsList();
  renderMemory();
  updateModelLabel();

  // Vérifier le statut du backend
  await checkBackendStatus();

  // Charger les documents indexés
  await loadDocumentsList();

  // Sidebar
  if (!state.sidebarOpen) {
    document.getElementById('sidebar').classList.add('collapsed');
  }

  // Dernière conversation
  const lastConvId = localStorage.getItem('bradley_last_conv');
  if (lastConvId && state.conversations[lastConvId]) {
    loadConversation(lastConvId);
  } else {
    newConversation();
  }

  document.addEventListener('keydown', handleGlobalShortcuts);
});

// ===========================
// BACKEND STATUS
// ===========================
async function checkBackendStatus() {
  try {
    const res  = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    setStatus('online');

    if (data.hasIndex) {
      showToast(`📚 ${data.docCount} doc(s) · ${data.totalChunks} chunks indexés`);
    }
  } catch (_) {
    setStatus('offline');
    showError('Backend hors ligne. Lance le serveur avec : npm start');
  }
}

// ===========================
// SETTINGS
// ===========================
function loadSettings() {
  const s = state.settings;
  if (s.model) document.getElementById('modelSelect').value = s.model;
  if (s.temp !== undefined) {
    document.getElementById('tempSlider').value       = s.temp;
    document.getElementById('tempValue').textContent  = s.temp;
  }
}

function saveSettings() {
  state.settings.model = document.getElementById('modelSelect').value;
  state.settings.temp  = parseFloat(document.getElementById('tempSlider').value);
  localStorage.setItem('bradley_settings', JSON.stringify(state.settings));
  updateModelLabel();
}

function updateTemp(el) {
  document.getElementById('tempValue').textContent = parseFloat(el.value).toFixed(1);
  saveSettings();
}

function updateModelLabel() {
  const model = document.getElementById('modelSelect').value;
  document.getElementById('modelLabel').textContent =
    model.split('-').slice(0, 3).join('-');
}

// ===========================
// STATUS
// ===========================
function setStatus(type) {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const map  = {
    online:  { cls: '',       txt: 'EN LIGNE' },
    offline: { cls: 'off',   txt: 'OFFLINE'  },
    error:   { cls: 'error', txt: 'ERREUR'   },
    loading: { cls: '',      txt: 'THINKING' },
  };
  const s = map[type] || map.offline;
  dot.className    = 'status-dot ' + s.cls;
  text.textContent = s.txt;
}

// ===========================
// SIDEBAR
// ===========================
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isOpen  = !sidebar.classList.contains('collapsed');
  sidebar.classList.toggle('collapsed', isOpen);
  state.sidebarOpen = !isOpen;
  localStorage.setItem('bradley_sidebar', String(!isOpen));
}

// ===========================
// CONVERSATIONS
// ===========================
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function newConversation() {
  const id = generateId();
  state.conversations[id] = {
    id,
    title:     'Nouvelle conversation',
    messages:  [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveConversations();
  loadConversation(id);
  renderConversationsList();
}

function loadConversation(id) {
  if (!state.conversations[id]) return;
  state.currentConvId = id;
  localStorage.setItem('bradley_last_conv', id);

  const conv = state.conversations[id];
  state.history    = conv.messages.map(m => ({ role: m.role, content: m.content }));
  state.tokenCount = estimateTokens(state.history);

  document.getElementById('convTitle').textContent = conv.title;
  updateTokenCounter();
  renderMessages(conv.messages);
  renderConversationsList();

  document.getElementById('regenBtn').style.display =
    conv.messages.length >= 2 ? 'flex' : 'none';
}

function saveConversations() {
  localStorage.setItem('bradley_conversations', JSON.stringify(state.conversations));
}

function deleteConversation(id) {
  delete state.conversations[id];
  saveConversations();
  renderConversationsList();
  if (state.currentConvId === id) {
    const ids = Object.keys(state.conversations);
    if (ids.length > 0) loadConversation(ids[ids.length - 1]);
    else newConversation();
  }
}

function deleteAllConversations() {
  if (!confirm('Supprimer toutes les conversations ?')) return;
  state.conversations = {};
  saveConversations();
  newConversation();
  renderConversationsList();
  showToast('Toutes les conversations supprimées');
}

function generateTitle(text) {
  return text.replace(/[#*`\n]/g, '').trim().slice(0, 42) + (text.length > 42 ? '…' : '');
}

function renderConversationsList() {
  const list  = document.getElementById('conversationsList');
  const convs = Object.values(state.conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (convs.length === 0) {
    list.innerHTML = '<div class="empty-list">Aucune conversation</div>';
    return;
  }

  list.innerHTML = convs.map(conv => `
    <div class="conv-item ${conv.id === state.currentConvId ? 'active' : ''}"
         onclick="loadConversation('${conv.id}')">
      <span class="conv-item-icon">💬</span>
      <div class="conv-item-info">
        <div class="conv-item-title">${escapeHtml(conv.title)}</div>
        <div class="conv-item-date">${formatDate(conv.updatedAt)}</div>
      </div>
      <button class="conv-item-del"
              onclick="event.stopPropagation(); deleteConversation('${conv.id}')">✕</button>
    </div>
  `).join('');
}

// ===========================
// MÉMOIRE
// ===========================
async function extractMemory(userText) {
  if (userText.trim().length < 8) return;
  try {
    const res  = await fetch(`${API_BASE}/memory/extract`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: userText }),
    });
    const { items } = await res.json();
    if (!items?.length) return;

    let updated = false;
    items.forEach(({ key, value, emoji }) => {
      if (!key || !value) return;
      const idx = state.memory.findIndex(m => m.key.toLowerCase() === key.toLowerCase());
      const entry = { key, value: String(value), emoji: emoji || '📌' };
      if (idx >= 0) state.memory[idx] = entry;
      else state.memory.push(entry);
      updated = true;
    });

    if (updated) {
      localStorage.setItem('bradley_memory', JSON.stringify(state.memory));
      renderMemory();
    }
  } catch (_) {}
}

function renderMemory() {
  const el = document.getElementById('memoryDisplay');
  if (state.memory.length === 0) {
    el.innerHTML = '<span class="memory-empty">Aucune info mémorisée</span>';
    return;
  }
  el.innerHTML = state.memory
    .map(m => `<span class="memory-tag" title="${escapeHtml(m.key)}: ${escapeHtml(m.value)}">${m.emoji} ${escapeHtml(m.value)}</span>`)
    .join('');
}

function clearMemory() {
  if (!confirm('Effacer toute la mémoire ?')) return;
  state.memory = [];
  localStorage.removeItem('bradley_memory');
  renderMemory();
  showToast('Mémoire effacée');
}

function buildMemoryArray() {
  return state.memory;
}

// ===========================
// DOCUMENTS RAG
// ===========================
async function loadDocumentsList() {
  try {
    const res  = await fetch(`${API_BASE}/documents`);
    const data = await res.json();
    renderDocumentsList(data.documents || []);
    updateRagBadge(data);
  } catch (_) {}
}

function renderDocumentsList(docs) {
  const el = document.getElementById('documentsList');
  if (!el) return;

  if (docs.length === 0) {
    el.innerHTML = '<div class="empty-list">Aucun document indexé</div>';
    return;
  }

  el.innerHTML = docs.map(doc => `
    <div class="doc-item">
      <span class="doc-icon">${doc.type === 'fixed' ? '📌' : '📄'}</span>
      <div class="doc-info">
        <div class="doc-name">${escapeHtml(doc.name)}</div>
        <div class="doc-meta">${doc.chunks || 0} chunks</div>
      </div>
    </div>
  `).join('');
}

function updateRagBadge(data) {
  const badge = document.getElementById('ragBadge');
  if (!badge) return;
  if (data.hasIndex) {
    badge.textContent = `RAG · ${data.totalChunks} chunks`;
    badge.classList.add('active');
  } else {
    badge.textContent = 'RAG · inactif';
    badge.classList.remove('active');
  }
}

async function handleFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  showToast(`📤 Upload de ${file.name}...`);

  try {
    const res  = await fetch(`${API_BASE}/documents/upload`, {
      method: 'POST',
      body:   formData,
    });
    const data = await res.json();

    if (data.success) {
      showToast(`✓ ${data.filename} — ${data.chunks} chunks indexés`);
      await loadDocumentsList();
    } else {
      showToast(`❌ Erreur: ${data.error}`);
    }
  } catch (err) {
    showToast(`❌ Upload échoué: ${err.message}`);
  }

  event.target.value = '';
}

// ===========================
// TOKEN COUNTER
// ===========================
function estimateTokens(messages) {
  return messages.reduce((acc, m) => acc + Math.ceil((m.content || '').length / 4), 0);
}

function updateTokenCounter() {
  document.getElementById('tokenCounter').textContent =
    `~${state.tokenCount.toLocaleString()} tokens`;
}

// ===========================
// SEND MESSAGE
// ===========================
async function sendMessage() {
  if (state.isLoading) return;

  const input = document.getElementById('userInput');
  const text  = input.value.trim();
  if (!text) return;

  // Extraction mémoire en arrière-plan
  extractMemory(text);

  // Ajouter message utilisateur
  const userMsg = { role: 'user', content: text, timestamp: Date.now() };
  addMessageToConv(userMsg);
  addMessageToUI('user', text, userMsg.timestamp);

  // Titre auto
  const conv = state.conversations[state.currentConvId];
  if (conv.messages.length === 1) {
    conv.title = generateTitle(text);
    document.getElementById('convTitle').textContent = conv.title;
    renderConversationsList();
  }

  input.value = '';
  input.style.height = 'auto';
  updateCharCount(0);

  // État chargement
  state.isLoading       = true;
  state.abortController = new AbortController();
  document.getElementById('sendBtn').style.display  = 'none';
  document.getElementById('stopBtn').style.display  = 'flex';
  document.getElementById('regenBtn').style.display = 'none';
  setStatus('loading');

  const typingEl = addTypingIndicator();

  try {
    const model = document.getElementById('modelSelect').value;
    const temp  = parseFloat(document.getElementById('tempSlider').value);

    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  state.abortController.signal,
      body: JSON.stringify({
        messages:    state.history,
        model,
        temperature: temp,
        memory:      buildMemoryArray(),
      }),
    });

    if (!response.ok) throw new Error(`Erreur serveur ${response.status}`);

    // Streaming SSE
    typingEl.remove();
    const { bodyEl, sourcesEl } = createStreamingBubble();

    let fullReply = '';
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;

        try {
          const parsed = JSON.parse(raw);

          if (parsed.type === 'sources' && parsed.sources?.length > 0) {
            sourcesEl.innerHTML =
              `<span class="rag-label">📚 Sources :</span> ` +
              parsed.sources.map(s => `<span class="rag-source">${escapeHtml(s)}</span>`).join(' ');
            sourcesEl.style.display = 'flex';
          }

          if (parsed.type === 'delta' && parsed.content) {
            fullReply += parsed.content;
            bodyEl.innerHTML =
              parseMarkdown(fullReply) + '<span class="streaming-cursor"></span>';
            scrollToBottom();
          }

          if (parsed.type === 'error') {
            throw new Error(parsed.message);
          }

        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }

    bodyEl.innerHTML = parseMarkdown(fullReply);
    addCopyButton(bodyEl.parentElement.querySelector('.msg-meta'), fullReply);

    const botMsg = { role: 'assistant', content: fullReply, timestamp: Date.now() };
    addMessageToConv(botMsg);

    state.tokenCount = estimateTokens(state.history);
    updateTokenCounter();
    setStatus('online');
    document.getElementById('regenBtn').style.display = 'flex';

  } catch (err) {
    typingEl?.remove();
    if (err.name !== 'AbortError') {
      showError(err.message || 'Connexion échouée.');
      setStatus('error');
    } else {
      setStatus('online');
      showToast('Génération arrêtée');
    }
  } finally {
    state.isLoading       = false;
    state.abortController = null;
    document.getElementById('sendBtn').style.display = 'flex';
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('userInput').focus();
    saveConversations();
  }
}

function stopGeneration() {
  if (state.abortController) state.abortController.abort();
}

// ===========================
// RÉGÉNÉRER
// ===========================
async function regenerateLastResponse() {
  const conv = state.conversations[state.currentConvId];
  if (!conv || conv.messages.length < 2) return;

  const lastBotIdx = [...conv.messages].reverse().findIndex(m => m.role === 'assistant');
  if (lastBotIdx === -1) return;
  conv.messages.splice(conv.messages.length - 1 - lastBotIdx, 1);
  state.history = conv.messages.map(m => ({ role: m.role, content: m.content }));
  saveConversations();
  renderMessages(conv.messages);

  // Simuler un sendMessage sans input utilisateur
  state.isLoading       = true;
  state.abortController = new AbortController();
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'flex';
  setStatus('loading');
  const typingEl = addTypingIndicator();

  try {
    const model = document.getElementById('modelSelect').value;
    const temp  = parseFloat(document.getElementById('tempSlider').value);

    const response = await fetch(`${API_BASE}/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  state.abortController.signal,
      body: JSON.stringify({ messages: state.history, model, temperature: temp, memory: buildMemoryArray() }),
    });

    if (!response.ok) throw new Error(`Erreur ${response.status}`);
    typingEl.remove();

    const { bodyEl, sourcesEl } = createStreamingBubble();
    let fullReply = '';
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n').filter(l => l.startsWith('data: '))) {
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;
        try {
          const p = JSON.parse(raw);
          if (p.type === 'sources' && p.sources?.length > 0) {
            sourcesEl.innerHTML = `<span class="rag-label">📚 Sources :</span> ` +
              p.sources.map(s => `<span class="rag-source">${escapeHtml(s)}</span>`).join(' ');
            sourcesEl.style.display = 'flex';
          }
          if (p.type === 'delta' && p.content) {
            fullReply += p.content;
            bodyEl.innerHTML = parseMarkdown(fullReply) + '<span class="streaming-cursor"></span>';
            scrollToBottom();
          }
        } catch (_) {}
      }
    }

    bodyEl.innerHTML = parseMarkdown(fullReply);
    addMessageToConv({ role: 'assistant', content: fullReply, timestamp: Date.now() });
    setStatus('online');

  } catch (err) {
    typingEl?.remove();
    if (err.name !== 'AbortError') { showError(err.message); setStatus('error'); }
    else setStatus('online');
  } finally {
    state.isLoading = false; state.abortController = null;
    document.getElementById('sendBtn').style.display = 'flex';
    document.getElementById('stopBtn').style.display = 'none';
    saveConversations();
  }
}

// ===========================
// CONVERSATION DATA
// ===========================
function addMessageToConv(msg) {
  const conv = state.conversations[state.currentConvId];
  if (!conv) return;
  conv.messages.push(msg);
  conv.updatedAt = Date.now();
  state.history.push({ role: msg.role, content: msg.content });
}

// ===========================
// UI — RENDER
// ===========================
function renderMessages(messages) {
  const container = document.getElementById('messages');
  container.innerHTML = '';

  if (messages.length === 0) {
    container.innerHTML = buildWelcomeHTML();
    return;
  }

  let lastDate = null;
  messages.forEach(msg => {
    const d = new Date(msg.timestamp || Date.now()).toDateString();
    if (d !== lastDate) {
      lastDate = d;
      container.appendChild(createDateSeparator(msg.timestamp));
    }
    addMessageToUI(
      msg.role === 'assistant' ? 'bot' : 'user',
      msg.content, msg.timestamp, false
    );
  });
  scrollToBottom();
}

function addMessageToUI(role, text, timestamp, animate = true) {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();

  const container = document.getElementById('messages');
  const msg    = document.createElement('div');
  const avatar = document.createElement('div');
  const body   = document.createElement('div');
  const bubble = document.createElement('div');
  const meta   = document.createElement('div');
  const ts     = document.createElement('span');

  msg.className      = `message ${role}`;
  if (!animate) msg.style.animation = 'none';
  avatar.className   = `avatar ${role}`;
  avatar.textContent = role === 'bot' ? 'BDY' : 'TOI';
  body.className     = 'msg-body';
  bubble.className   = 'bubble';
  bubble.innerHTML   = role === 'bot' ? parseMarkdown(text) : escapeHtml(text);
  ts.className       = 'timestamp';
  ts.textContent     = formatTime(timestamp || Date.now());
  meta.className     = 'msg-meta';
  meta.appendChild(ts);
  addCopyButton(meta, text);

  body.appendChild(bubble);
  body.appendChild(meta);
  msg.appendChild(avatar);
  msg.appendChild(body);
  container.appendChild(msg);
  if (animate) scrollToBottom();
}

function createStreamingBubble() {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();

  const container  = document.getElementById('messages');
  const msg        = document.createElement('div');
  const avatar     = document.createElement('div');
  const body       = document.createElement('div');
  const bubble     = document.createElement('div');
  const sourcesDiv = document.createElement('div');
  const meta       = document.createElement('div');
  const ts         = document.createElement('span');

  msg.className        = 'message bot';
  avatar.className     = 'avatar bot';
  avatar.textContent   = 'BDY';
  body.className       = 'msg-body';
  bubble.className     = 'bubble';
  sourcesDiv.className = 'rag-sources';
  sourcesDiv.style.display = 'none';
  ts.className         = 'timestamp';
  ts.textContent       = formatTime(Date.now());
  meta.className       = 'msg-meta';
  meta.appendChild(ts);

  body.appendChild(sourcesDiv);
  body.appendChild(bubble);
  body.appendChild(meta);
  msg.appendChild(avatar);
  msg.appendChild(body);
  container.appendChild(msg);
  scrollToBottom();

  return { bodyEl: bubble, sourcesEl: sourcesDiv };
}

function addCopyButton(container, text) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.className   = 'msg-action-btn';
  btn.textContent = '📋';
  btn.title       = 'Copier';
  btn.onclick     = () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '📋'; }, 1500);
    });
  };
  actions.appendChild(btn);
  container.appendChild(actions);
}

function addTypingIndicator() {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();
  const container  = document.getElementById('messages');
  const msg        = document.createElement('div');
  const avatar     = document.createElement('div');
  const bubble     = document.createElement('div');
  msg.className    = 'message bot'; msg.id = 'typing-indicator';
  avatar.className = 'avatar bot'; avatar.textContent = 'BDY';
  bubble.className = 'bubble';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  msg.appendChild(avatar); msg.appendChild(bubble);
  container.appendChild(msg); scrollToBottom();
  return msg;
}

function createDateSeparator(ts) {
  const el = document.createElement('div');
  el.className = 'date-separator';
  el.innerHTML = `<span>${formatDate(ts)}</span>`;
  return el;
}

function showError(message) {
  const container = document.getElementById('messages');
  const err       = document.createElement('div');
  err.className   = 'error-msg';
  err.innerHTML   = `⚠️ ${escapeHtml(message)}`;
  container.appendChild(err);
  scrollToBottom();
  setTimeout(() => err.remove(), 8000);
}

function buildWelcomeHTML() {
  return `
    <div class="welcome" id="welcome">
      <svg class="welcome-crest" width="80" height="80" viewBox="0 0 90 90" fill="none">
        <circle cx="45" cy="45" r="43" fill="#001a3a" stroke="#CEAB5D" stroke-width="2"/>
        <circle cx="45" cy="45" r="35" fill="none" stroke="#CEAB5D" stroke-width="1" opacity="0.4"/>
        <path d="M45 14 L40 34 L33 55 L29 66 L61 66 L57 55 L50 34 Z" fill="none" stroke="white" stroke-width="2" stroke-linejoin="round"/>
        <line x1="35" y1="42" x2="55" y2="42" stroke="white" stroke-width="1.5"/>
        <line x1="32" y1="54" x2="58" y2="54" stroke="white" stroke-width="1.5"/>
        <path d="M10 45 A35 35 0 0 1 45 10" stroke="#DA291C" stroke-width="7" fill="none" opacity="0.6" stroke-linecap="round"/>
      </svg>
      <div class="welcome-name">BRADLEY</div>
      <div class="welcome-strip"></div>
      <div class="welcome-sub">Paris Saint-Germain · Intelligence Artificielle · RAG</div>
      <p class="welcome-desc">Allez Paris ! Bradley peut lire tes documents et répondre dessus.</p>
      <div class="suggestions">
        <div class="suggestion" onclick="usePrompt(this)">Que contient ma base de docs ?</div>
        <div class="suggestion" onclick="usePrompt(this)">Analyse tactique PSG</div>
        <div class="suggestion" onclick="usePrompt(this)">Aide-moi a coder en JS</div>
        <div class="suggestion" onclick="usePrompt(this)">Ecris un email professionnel</div>
      </div>
    </div>`;
}

// ===========================
// INPUT
// ===========================
function handleInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  updateCharCount(el.value.length);
}

function updateCharCount(n) {
  const el = document.getElementById('charCount');
  el.textContent = n > 0 ? n : '';
  el.className   = 'char-count' + (n > 3000 ? ' warn' : '');
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function handleGlobalShortcuts(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); newConversation(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
}

function usePrompt(el) {
  const input = document.getElementById('userInput');
  input.value = el.textContent; handleInput(input); input.focus();
}

// ===========================
// EXPORT
// ===========================
function exportConversation() {
  const conv = state.conversations[state.currentConvId];
  if (!conv || conv.messages.length === 0) { showToast('Aucun message'); return; }
  const lines = [
    'BRADLEY — Export', `Titre: ${conv.title}`,
    `Date: ${new Date(conv.createdAt).toLocaleString('fr-FR')}`, '─'.repeat(40), '',
    ...conv.messages.map(m => `[${formatTime(m.timestamp||Date.now())}] ${m.role==='assistant'?'BRADLEY':'VOUS'}:\n${m.content}\n`),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `bradley-${conv.title.slice(0,20)}.txt` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('Exporté ✓');
}

// ===========================
// MARKDOWN
// ===========================
function parseMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, c) => `<pre><code>${escapeHtml(c.trim())}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/^> (.+)$/gm,   '<blockquote>$1</blockquote>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm,  '<li>$1</li>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
}

// ===========================
// UTILITAIRES
// ===========================
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
}
function formatDate(ts) {
  const diff = Math.floor((Date.now() - ts) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return new Date(ts).toLocaleDateString('fr-FR', { day:'numeric', month:'short' });
}
function scrollToBottom() {
  const c = document.getElementById('messages'); c.scrollTop = c.scrollHeight;
}
function showToast(msg) {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.appendChild(t); setTimeout(() => t.remove(), 2500);
}