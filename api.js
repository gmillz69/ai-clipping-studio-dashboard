/**
 * AI Clipping Studio — API Client (based on OpenSource Clipping Studio, MIT)
 *
 * Shared module for all studio pages.
 *
 * [ai-clipping-studio] Security model for a PUBLIC static dashboard:
 *  - This file contains no credentials of any kind.
 *  - The backend URL (not secret) is remembered in localStorage.
 *  - Signing in exchanges the operator's username/password for a short-lived
 *    session token. Only that token is kept, in sessionStorage (cleared when
 *    the tab closes), bound to the backend URL it was issued by.
 *  - Every request carries "Authorization: Bearer <token>"; any 401 drops the
 *    session and returns the UI to "Sign-in required".
 *  - Clip previews/downloads use short-lived signed URLs issued by the backend.
 */

const StudioAPI = (() => {
  const STORAGE_KEY = 'osc_backend_url';
  const SESSION_KEY = 'osc_session';
  const SERVICE_ID = 'ai-clipping-studio';
  const TUNNEL_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
  let connection = { status: 'unknown', ready: null };
  let connectionCheck = null;
  let memorySession = null;   // fallback when sessionStorage is unavailable

  function setConnection(status, details = {}) {
    connection = { status, ready: null, ...details };
    window.dispatchEvent(new CustomEvent('studio:connection', { detail: connection }));
  }

  function normalizeBackendUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch (_) { throw StudioI18n.error('api.invalidUrl'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw StudioI18n.error('api.invalidUrl');
    }
    return url.href.replace(/\/+$/, '');
  }

  // ---- Backend URL (not secret) ----
  function getBackendUrl() {
    try { return (localStorage.getItem(STORAGE_KEY) || '').replace(/\/+$/, ''); } catch (_) { return ''; }
  }

  function setBackendUrl(url) {
    const normalized = normalizeBackendUrl(url);
    try { localStorage.setItem(STORAGE_KEY, normalized); } catch (_) { /* per-tab only */ }
    if (getSession()?.base !== normalized) clearSession();
    setConnection('unknown');
  }

  function clearBackendUrl() {
    clearSession();
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
    setConnection('offline');
    window.dispatchEvent(new CustomEvent('studio:disconnected'));
  }

  function isConfigured() {
    return !!getBackendUrl();
  }

  // ---- Session (short-lived token, this tab only) ----
  function readSessionStore() {
    try {
      const raw = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem(SESSION_KEY) : null;
      return raw ? JSON.parse(raw) : memorySession;
    } catch (_) {
      return memorySession;
    }
  }

  function getSession() {
    const session = readSessionStore();
    if (!session || !session.token || !session.base) return null;
    if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
      clearSession();
      return null;
    }
    return session;
  }

  function saveSession(session) {
    memorySession = session;
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
    catch (_) { /* memory only */ }
  }

  function clearSession() {
    memorySession = null;
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
  }

  function authHeaders(base) {
    const session = getSession();
    return session && session.base === base ? { Authorization: `Bearer ${session.token}` } : {};
  }

  function isSignedIn() {
    const session = getSession();
    return !!session && session.base === getBackendUrl();
  }

  function currentUser() {
    return isSignedIn() ? getSession().user : null;
  }

  function signedOutError() {
    const error = StudioI18n.error('api.signInRequired');
    error.status = 401;
    error.signedOut = true;
    return error;
  }

  /** Generic fetch wrapper; candidate connections do not change the saved URL. */
  async function requestAt(base, path, options = {}) {
    if (!base) throw StudioI18n.error('api.noBackend');
    const { timeoutMs = 30000, auth = true, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...TUNNEL_HEADERS,
          ...(auth ? authHeaders(base) : {}),
          ...(fetchOptions.headers || {}),
        },
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401 && auth) {
        // Expired/revoked token: fall back to the sign-in state, never retry blindly.
        const session = getSession();
        if (session && session.base === base) {
          clearSession();
          if (base === getBackendUrl()) setConnection('signed_out');
        }
        throw signedOutError();
      }
      if (!res.ok) {
        const detail = body?.detail;
        const error = typeof detail === 'string' ? new Error(detail) : StudioI18n.error('api.requestFailed', { status: res.status });
        error.status = res.status;
        error.body = body;
        throw error;
      }
      if (body === null) throw StudioI18n.error('api.unexpectedPage');
      return body;
    } catch (error) {
      if (!error.status && base === getBackendUrl()) setConnection('unreachable');
      if (error.name === 'AbortError') throw StudioI18n.error('api.timeout');
      if (error.name === 'TypeError') throw StudioI18n.error('api.network');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function request(path, options = {}) {
    return requestAt(getBackendUrl(), path, options);
  }

  // ---- Health / connection ----
  async function checkHealth() {
    return request('/api/health');
  }

  /** Reachability + identity (public), then readiness (authenticated) if signed in. */
  async function probeConnection(base) {
    const info = await requestAt(base, '/api/auth/status', { auth: false });
    if (info.service !== SERVICE_ID || info.auth_required !== true) {
      throw StudioI18n.error('api.notOurBackend');
    }
    const session = getSession();
    if (!session || session.base !== base) {
      return { signedIn: false, mode: info.mode };
    }
    let readiness;
    try {
      readiness = await requestAt(base, '/api/ready', { timeoutMs: 150000 });
    } catch (error) {
      if (error.status === 503) {
        const failure = StudioI18n.error('api.notReady');
        failure.notReady = true;
        throw failure;
      }
      throw error;
    }
    if (readiness.ready !== true) {
      const error = StudioI18n.error('api.notReady');
      error.notReady = true;
      throw error;
    }
    return { signedIn: true, ready: true, mode: info.mode, user: session.user };
  }

  function statusFor(result) {
    return result.signedIn ? 'online' : 'signed_out';
  }

  async function checkConnection() {
    const base = getBackendUrl();
    if (!base) { setConnection('offline'); return null; }
    if (connectionCheck?.base === base) return connectionCheck.promise;
    const pending = { base };
    pending.promise = (async () => {
      try {
        const result = await probeConnection(base);
        if (base === getBackendUrl()) setConnection(statusFor(result), result);
        return result;
      } catch (error) {
        if (base === getBackendUrl()) {
          setConnection(error.notReady ? 'not_ready' : error.signedOut ? 'signed_out' : 'unreachable');
        }
        throw error;
      }
    })();
    connectionCheck = pending;
    try {
      return await pending.promise;
    } finally {
      if (connectionCheck === pending) connectionCheck = null;
    }
  }

  /** Remember a backend URL after confirming it is this project's backend. */
  async function connect(url) {
    const base = normalizeBackendUrl(url);
    let result;
    try {
      result = await probeConnection(base);
    } catch (error) {
      if (base === getBackendUrl()) setConnection(error.notReady ? 'not_ready' : 'unreachable');
      throw error;
    }
    setBackendUrl(base);
    setConnection(statusFor(result), result);
    window.dispatchEvent(new CustomEvent('studio:connected', { detail: result }));
    return result;
  }

  /** Exchange credentials for a short-lived session token. The password is not stored. */
  async function signIn(url, username, password) {
    const base = normalizeBackendUrl(url);
    const info = await requestAt(base, '/api/auth/status', { auth: false });
    if (info.service !== SERVICE_ID) throw StudioI18n.error('api.notOurBackend');
    let login;
    try {
      login = await requestAt(base, '/api/auth/login', {
        method: 'POST', auth: false,
        body: JSON.stringify({ username: String(username || '').trim(), password: String(password || '') }),
      });
    } catch (error) {
      if (error.status === 401) throw StudioI18n.error('api.badCredentials');
      throw error;
    }
    if (getBackendUrl() !== base) {
      try { localStorage.setItem(STORAGE_KEY, base); } catch (_) { /* per-tab only */ }
    }
    saveSession({ base, token: login.token, expires_at: login.expires_at, user: login.user });
    const result = await probeConnection(base).catch(error => {
      setConnection(error.notReady ? 'not_ready' : 'unreachable');
      throw error;
    });
    setConnection('online', result);
    window.dispatchEvent(new CustomEvent('studio:connected', { detail: result }));
    return result;
  }

  async function signOut() {
    const base = getBackendUrl();
    if (isSignedIn()) {
      await requestAt(base, '/api/auth/logout', { method: 'POST', timeoutMs: 8000 }).catch(() => {});
    }
    clearSession();
    setConnection(base ? 'signed_out' : 'offline');
    window.dispatchEvent(new CustomEvent('studio:signedout'));
  }

  // ---- Jobs ----
  async function fetchJobs() {
    return request('/api/jobs');
  }

  async function fetchJob(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  async function createJob(payload) {
    return request('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
  }

  async function resumeJob(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' });
  }

  async function deleteJob(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  async function fetchSystem() {
    return request('/api/system', { timeoutMs: 60000 });
  }

  /** Upload a recording with progress. Resolves with the server's {filename, size_mb}. */
  function uploadVideo(file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const base = getBackendUrl();
      if (!base) { reject(StudioI18n.error('api.noBackend')); return; }
      if (!isSignedIn()) { reject(signedOutError()); return; }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/api/upload`);
      Object.entries({ ...TUNNEL_HEADERS, ...authHeaders(base) }).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (_) { /* non-JSON */ }
        if (xhr.status === 401) {
          clearSession(); setConnection('signed_out'); reject(signedOutError()); return;
        }
        if (xhr.status < 200 || xhr.status >= 300 || !body) {
          const error = typeof body?.detail === 'string' ? new Error(body.detail)
            : StudioI18n.error('api.requestFailed', { status: xhr.status });
          error.status = xhr.status;
          reject(error);
          return;
        }
        resolve(body);
      };
      xhr.onerror = () => { setConnection('unreachable'); reject(StudioI18n.error('api.network')); };
      xhr.ontimeout = () => reject(StudioI18n.error('api.timeout'));
      const form = new FormData();
      form.append('file', file, file.name);
      xhr.send(form);
    });
  }

  // ---- Settings ----
  async function fetchSettings() {
    return request('/api/settings');
  }

  async function updateSettings(payload) {
    return request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
  }

  function uploadYoutubeCookies(file) {
    return request('/api/settings/youtube-cookies', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: file, redirect: 'error',
    });
  }

  function removeYoutubeCookies() {
    return request('/api/settings/youtube-cookies', { method: 'DELETE', redirect: 'error' });
  }

  // ---- Live job status (SSE over fetch, so the auth header can be sent) ----
  const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

  function createSSE(jobId, onMessage, onError = () => {}) {
    const base = getBackendUrl();
    if (!base) return null;
    let closed = false;
    let retryTimer = null;
    let controller;
    const stream = {
      close() {
        closed = true;
        clearTimeout(retryTimer);
        if (controller) controller.abort();
      },
    };

    async function run() {
      controller = new AbortController();
      let reader;
      try {
        const response = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}/status`, {
          headers: { Accept: 'text/event-stream', ...TUNNEL_HEADERS, ...authHeaders(base) },
          signal: controller.signal,
        });
        if (response.status === 401) {
          clearSession(); setConnection('signed_out'); stream.close(); onError(signedOutError()); return;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
          throw StudioI18n.error('api.liveUnavailable');
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let separator;
          while ((separator = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, separator.index);
            pending = pending.slice(separator.index + separator[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            const event = JSON.parse(data);
            onMessage(event);
            if (TERMINAL.includes(event.type)) stream.close();
            if (closed) break;
          }
        }
      } catch (error) {
        if (!closed) onError(error);
      } finally {
        if (reader) await reader.cancel().catch(() => {});
        if (!closed) retryTimer = setTimeout(run, 3000);
      }
    }
    run();
    return stream;
  }

  /** [ai-clipping-studio] Fetch an output file with the tunnel and auth headers.
   *  <video src> and plain links cannot send headers, so free ngrok tunnels may
   *  answer them with a browser-warning page; fetching first avoids that. */
  async function fetchOutputBlob(path) {
    const base = getBackendUrl();
    if (!base) throw StudioI18n.error('api.noBackend');
    if (!String(path).startsWith('/api/outputs/')) throw StudioI18n.error('api.unexpectedPage');
    const res = await fetch(`${base}${path}`, { headers: { ...TUNNEL_HEADERS, ...authHeaders(base) } });
    if (res.status === 401) { clearSession(); setConnection('signed_out'); throw signedOutError(); }
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('text/html')) {
      throw StudioI18n.error('api.requestFailed', { status: res.status });
    }
    return res.blob();
  }

  // ---- Server Shutdown (administrators only; enforced by the backend) ----
  async function shutdownServer() {
    return request('/api/shutdown', { method: 'POST' });
  }

  return {
    getBackendUrl,
    setBackendUrl,
    clearBackendUrl,
    isConfigured,
    isSignedIn,
    currentUser,
    connect,
    signIn,
    signOut,
    checkConnection,
    getConnectionState: () => connection,
    checkHealth,
    fetchJobs,
    fetchJob,
    createJob,
    resumeJob,
    deleteJob,
    fetchSystem,
    uploadVideo,
    fetchSettings,
    updateSettings,
    uploadYoutubeCookies,
    removeYoutubeCookies,
    createSSE,
    fetchOutputBlob,
    shutdownServer,
  };
})();


// ============================================================
// Shared UI Utilities (used across all studio pages)
// ============================================================

/** Theme toggle */
function toggleTheme() {
  if (document.documentElement.classList.contains('dark')) {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  }
}

/** Format date string to locale */
function formatDate(dateStr) {
  return StudioI18n.formatDate(dateStr);
}

/** Escape backend-provided text before inserting it into an HTML template. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

/** Known API status codes stay unchanged; only their display labels are localized. */
function statusKey(status, cancelRequested = false) {
  if (cancelRequested && !['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return 'status.cancelling';
  return ['queued', 'downloading', 'transcribing', 'analyzing', 'rendering', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)
    ? `status.${status}` : 'common.message';
}

/** [ai-clipping-studio] Which engine selected a clip: AI (local LLM) or heuristic. */
function clipEngine(clip) {
  const meta = clip?.metadata || {};
  const engine = String(meta.analysis_engine || clip?.analysis_engine || '');
  if (engine.startsWith('llm')) return { kind: 'ai', key: 'clip.engineAi', model: meta.analysis_model || '' };
  if (engine === 'heuristic') return { kind: 'heuristic', key: 'clip.engineHeuristic', model: '' };
  return { kind: 'unknown', key: 'clip.engineUnknown', model: '' };
}

/** [ai-clipping-studio] Play a clip in its card after fetching it through the API. */
async function previewClip(button) {
  const card = button.closest('.clip-card');
  const video = card.querySelector('video');
  const note = card.querySelector('.preview-note');
  button.disabled = true;
  StudioI18n.text(button, 'job.loadingPreview');
  try {
    if (!video.dataset.loaded) {
      const blob = await StudioAPI.fetchOutputBlob(video.dataset.path);
      video.src = URL.createObjectURL(blob);
      video.dataset.loaded = '1';
    }
    button.classList.add('hidden');
    await video.play().catch(() => {});
  } catch (err) {
    button.disabled = false;
    StudioI18n.text(button, 'job.preview');
    note.classList.remove('hidden');
    StudioI18n.text(note, 'common.message', { message: StudioI18n.errorMessage(err) });
  }
}

/** [ai-clipping-studio] Save a clip/subtitle file fetched through the API. */
async function downloadOutput(link) {
  const original = link.textContent;
  link.setAttribute('aria-busy', 'true');
  try {
    const blob = await StudioAPI.fetchOutputBlob(link.dataset.path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = link.dataset.filename || 'clip.mp4';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    link.textContent = StudioI18n.errorMessage(err);
    setTimeout(() => { link.textContent = original; }, 4000);
  } finally {
    link.removeAttribute('aria-busy');
  }
}

/** Mobile sidebar toggle */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  sidebar.classList.toggle('open');
  overlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none';
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  sidebar.classList.remove('open');
  overlay.style.display = 'none';
}

/** Update sidebar connection indicator */
function updateConnectIndicator() {
  const dot = document.getElementById('connect-dot');
  const label = document.getElementById('connect-label');
  const btn = document.getElementById('connect-btn');
  const stopBtn = document.getElementById('sidebar-stop-btn');
  if (!dot || !label) return;

  const connection = StudioAPI.getConnectionState();
  const user = StudioAPI.currentUser();
  if (StudioAPI.isConfigured() && connection.status === 'online' && user) {
    dot.className = 'connect-dot online';
    let host = '';
    try { host = new URL(StudioAPI.getBackendUrl()).hostname; } catch (_) { /* ignore */ }
    StudioI18n.text(label, 'connection.signedInAs', { user: user.username, host });
    if (btn) StudioI18n.text(btn, 'connection.account');
    if (stopBtn) stopBtn.classList.toggle('hidden', user.role !== 'admin');
  } else {
    dot.className = `connect-dot ${connection.status === 'signed_out' ? 'warning' : 'offline'}`;
    const key = !StudioAPI.isConfigured() ? 'connection.offline'
      : connection.status === 'signed_out' ? 'connection.signInRequired'
      : connection.status === 'not_ready' ? 'connection.notReady'
      : connection.status === 'unknown' ? 'connection.checking'
      : 'connection.unreachable';
    StudioI18n.text(label, key);
    if (btn) StudioI18n.text(btn, StudioAPI.isConfigured() ? 'connection.signIn' : 'common.connect');
    if (stopBtn) stopBtn.classList.add('hidden');
  }
}

/** Connect / sign-in dialog. Credentials go only to the backend URL entered here. */
function showConnectModal() {
  const existing = document.getElementById('connect-modal-backdrop');
  if (existing) existing.remove();

  const currentUrl = StudioAPI.getBackendUrl();
  const user = StudioAPI.currentUser();
  const field = 'w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 text-slate-900 dark:text-white placeholder-slate-400';

  const backdrop = document.createElement('div');
  backdrop.id = 'connect-modal-backdrop';
  backdrop.className = 'connect-modal-backdrop';
  backdrop.innerHTML = `
    <div class="connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-modal-title">
      <div class="flex items-center justify-between mb-4">
        <h3 id="connect-modal-title" class="font-display font-bold text-lg text-slate-900 dark:text-white">${StudioI18n.html(user ? 'connection.accountTitle' : 'connection.title')}</h3>
        <button onclick="closeConnectModal()" aria-label="${tr('connection.close')}" data-i18n-aria-label="connection.close" class="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
          <i data-lucide="x" class="w-5 h-5 text-slate-400"></i>
        </button>
      </div>
      ${user ? `
        <p class="text-sm text-slate-600 dark:text-slate-300 mb-1">${StudioI18n.html('connection.signedInDetail', { user: user.username, role: user.role })}</p>
        <p class="text-xs text-slate-400 font-mono break-all mb-5">${escapeHtml(currentUrl)}</p>
        <div id="connect-status-msg" class="text-sm mb-4 hidden"></div>
        <div class="flex flex-wrap gap-2">
          <button onclick="signOutBackend()" class="flex-1 px-4 py-2.5 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700 transition-colors text-sm">${StudioI18n.html('connection.signOut')}</button>
          <button onclick="disconnectBackend()" title="${tr('connection.disconnectHint')}" data-i18n-title="connection.disconnectHint" class="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-sm">${StudioI18n.html('connection.disconnect')}</button>
          ${user.role === 'admin' ? `
          <button id="stop-server-btn" onclick="stopBackendServer()" title="${tr('connection.stopHint')}" data-i18n-title="connection.stopHint" class="px-3 py-2.5 rounded-xl border border-red-500 bg-red-600 text-white font-medium hover:bg-red-700 transition-colors text-sm">${StudioI18n.html('connection.stop')}</button>` : ''}
        </div>
      ` : `
        <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">${StudioI18n.html('connection.help')}</p>
        <form id="connect-form" onsubmit="event.preventDefault(); signInAndConnect()" class="space-y-3 mb-4">
          <input id="connect-url-input" type="url" required aria-label="${tr('connection.url')}" data-i18n-aria-label="connection.url"
            placeholder="https://xxxx-xx-xx.ngrok-free.app" class="${field} font-mono" autocomplete="url" />
          <input id="connect-user-input" type="text" required aria-label="${tr('connection.username')}" data-i18n-aria-label="connection.username"
            placeholder="${tr('connection.username')}" data-i18n-placeholder="connection.username" class="${field}" autocomplete="username" autocapitalize="none" spellcheck="false" />
          <input id="connect-password-input" type="password" required minlength="1" aria-label="${tr('connection.password')}" data-i18n-aria-label="connection.password"
            placeholder="${tr('connection.password')}" data-i18n-placeholder="connection.password" class="${field}" autocomplete="current-password" />
          <p class="text-xs text-slate-400">${StudioI18n.html('connection.privacy')}</p>
          <div id="connect-status-msg" class="text-sm hidden"></div>
          <div class="flex gap-3 pt-1">
            <button id="connect-test-btn" type="submit" class="flex-1 px-4 py-2.5 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700 transition-colors text-sm">${StudioI18n.html('connection.signInButton')}</button>
            ${currentUrl ? `<button type="button" onclick="disconnectBackend()" title="${tr('connection.disconnectHint')}" data-i18n-title="connection.disconnectHint" class="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-sm">${StudioI18n.html('connection.forget')}</button>` : ''}
          </div>
        </form>
      `}
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeConnectModal();
  });
  lucide.createIcons();
  const urlInput = document.getElementById('connect-url-input');
  if (urlInput) {
    urlInput.value = currentUrl;
    (currentUrl ? document.getElementById('connect-user-input') : urlInput).focus();
  }
}

function closeConnectModal() {
  const backdrop = document.getElementById('connect-modal-backdrop');
  if (backdrop) backdrop.remove();
}

function showConnectMessage(key, params, tone) {
  const msg = document.getElementById('connect-status-msg');
  if (!msg) return;
  const colours = { error: 'text-red-500', ok: 'text-emerald-600 dark:text-emerald-400', info: 'text-slate-500 dark:text-slate-400' };
  msg.className = `text-sm ${colours[tone] || colours.info}`;
  StudioI18n.text(msg, key, params);
  msg.classList.remove('hidden');
}

async function signInAndConnect() {
  const url = document.getElementById('connect-url-input').value.trim();
  const username = document.getElementById('connect-user-input').value.trim();
  const passwordInput = document.getElementById('connect-password-input');
  const btn = document.getElementById('connect-test-btn');
  if (!url) { showConnectMessage('connection.enterUrl', {}, 'error'); return; }
  if (!username || !passwordInput.value) { showConnectMessage('connection.enterCredentials', {}, 'error'); return; }

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner spinner-dark"></span> ${StudioI18n.html('connection.signingIn')}`;
  showConnectMessage('connection.connecting', {}, 'info');
  try {
    await StudioAPI.signIn(url, username, passwordInput.value);
    passwordInput.value = '';
    showConnectMessage('connection.success', {}, 'ok');
    updateConnectIndicator();
    setTimeout(() => closeConnectModal(), 900);
  } catch (err) {
    passwordInput.value = '';
    showConnectMessage('connection.failed', { message: StudioI18n.errorMessage(err) }, 'error');
    updateConnectIndicator();
  } finally {
    btn.disabled = false;
    btn.innerHTML = StudioI18n.html('connection.signInButton');
  }
}

async function signOutBackend() {
  await StudioAPI.signOut();
  updateConnectIndicator();
  closeConnectModal();
}

function disconnectBackend() {
  StudioAPI.clearBackendUrl();
  updateConnectIndicator();
  closeConnectModal();
}

async function stopBackendServer() {
  const btn = document.getElementById('stop-server-btn');
  if (!confirm(tr('connection.stopConfirm'))) return;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner spinner-light"></span> ${StudioI18n.html('connection.stopping')}`;
  }
  showConnectMessage('connection.shutdownSignal', {}, 'info');
  try {
    await StudioAPI.shutdownServer();
    showConnectMessage('connection.stopped', {}, 'ok');
  } catch (err) {
    showConnectMessage('connection.shutdownFailed', { message: StudioI18n.errorMessage(err) }, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = StudioI18n.html('connection.stop'); }
    return;
  }
  setTimeout(() => {
    StudioAPI.clearBackendUrl();
    updateConnectIndicator();
    closeConnectModal();
  }, 1500);
}

/** Banner text for pages that need a signed-in backend. */
function connectionProblemKey() {
  const status = StudioAPI.getConnectionState().status;
  if (!StudioAPI.isConfigured()) return 'connection.bannerNotConnected';
  if (status === 'signed_out') return 'connection.bannerSignIn';
  if (status === 'not_ready') return 'connection.bannerNotReady';
  if (status === 'unreachable') return 'connection.bannerOffline';
  return null;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  updateConnectIndicator();
  StudioAPI.checkConnection().catch(() => {});
  setInterval(() => StudioAPI.checkConnection().catch(() => {}), 15000);
});
window.addEventListener('studio:connection', updateConnectIndicator);
