const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null, csrfToken: '', authMode: 'register', currentPage: 'home', room: null, socket: null,
  resetToken: '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  peerId: '', localStream: null, screenStream: null, connections: new Map(), remotePeers: new Map(),
  pollTimer: null, presenceTimer: null, clockTimer: null, startedAt: 0, micOn: true, cameraOn: true,
  chatOpen: true, activeTab: 'chat', unread: false, screenSharing: false, boardDrawing: false,
  boardColor: '#456b4a', boardErase: false, boardStrokes: [], fileTransfers: new Map(),
};
let activeTheme = 'light';

function setTheme(theme, persist = true) {
  activeTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = activeTheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', activeTheme === 'dark' ? '#091c2a' : '#f7fcff');
  const dark = activeTheme === 'dark';
  $$('.theme-toggle').forEach((button) => {
    const nextMode = dark ? 'day' : 'night';
    button.setAttribute('aria-label', `Switch to ${nextMode} mode`);
    button.setAttribute('title', `Switch to ${nextMode} mode`);
    button.setAttribute('aria-pressed', String(dark));
    $('.theme-toggle-icon', button).textContent = dark ? '☀' : '☾';
    $('.theme-toggle-label', button).textContent = dark ? 'Day mode' : 'Night mode';
  });
  if (persist) {
    try { localStorage.setItem('meeting-theme', activeTheme); } catch {}
  }
}

function initTheme() {
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('meeting-theme') || 'light'; } catch {}
  setTheme(savedTheme, false);
}

function toast(message, kind = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${kind === 'error' ? 'error' : ''}`;
  node.textContent = message;
  $('#toast-region').append(node);
  window.setTimeout(() => node.remove(), 3400);
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const csrfExempt = ['/api/auth/login', '/api/auth/register', '/api/auth/verify-email', '/api/auth/resend-verification', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/guest/session'];
  if (method !== 'GET' && state.csrfToken && !csrfExempt.includes(path)) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  if (result.csrfToken) state.csrfToken = result.csrfToken;
  return result;
}

function showAuth(mode = 'register') {
  $('#auth-view').hidden = false;
  $('#app-view').hidden = true;
  setAuthMode(mode);
}

function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#profile-name').textContent = state.user.name;
  $('#profile-avatar').textContent = state.user.initials;
  $('#topbar-avatar').textContent = state.user.initials;
  $('#admin-nav').hidden = state.user.role !== 'admin';
  $('#greeting-name').textContent = state.user.name.split(' ')[0];
  $('#home-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
  renderPage('home');
  refreshWorkspaceRooms();
  refreshServiceHealth();
}

async function refreshServiceHealth() {
  const label = $('#service-status');
  const wrapper = $('#service-status-wrap');
  if (!label || !wrapper) return;
  try {
    const result = await api('/api/health');
    label.textContent = result.ok ? 'Workspace online' : 'Workspace unavailable';
    wrapper.classList.toggle('status-offline', !result.ok);
  } catch {
    label.textContent = 'Connection unavailable';
    wrapper.classList.add('status-offline');
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  const login = mode === 'login';
  const forgot = mode === 'forgot';
  const reset = mode === 'reset';
  const titles = { register: 'Create your account', login: 'Welcome back', forgot: 'Reset your password', reset: 'Choose a new password' };
  const subtitles = {
    register: 'Start making room for better conversations.',
    login: 'Sign in and pick up where you left off.',
    forgot: 'Enter your account email and we will send a secure reset link.',
    reset: 'Choose a new password for your Meeting account.',
  };
  $('#auth-title').textContent = titles[mode] || titles.login;
  $('#auth-subtitle').textContent = subtitles[mode] || subtitles.login;
  $('#auth-submit-label').textContent = ({ register: 'Create account', login: 'Sign in', forgot: 'Send reset link', reset: 'Save new password' })[mode] || 'Sign in';
  const authTopLabel = $('#auth-top-label');
  if (authTopLabel) authTopLabel.textContent = register ? 'Already have an account?' : (login ? 'New to Meeting?' : 'Remembered your password?');
  $('#auth-mode-toggle').textContent = register ? 'Sign in' : (login ? 'Create account' : 'Back to sign in');
  $('#auth-mode-toggle').hidden = false;
  $('#name-field').hidden = !register;
  $('#email-field').hidden = reset;
  $('#password-field').hidden = forgot;
  $('#confirm-password-field').hidden = !reset;
  $('#auth-help').hidden = !login;
  $('#guest-join-form').hidden = reset;
  $('.guest-divider').hidden = reset;
  $('#auth-form [name="name"]').required = register;
  $('#auth-form [name="email"]').required = !reset;
  const password = $('#auth-form [name="password"]');
  password.required = !forgot;
  password.autocomplete = register || reset ? 'new-password' : 'current-password';
  password.placeholder = register || reset ? 'At least 10 characters' : 'Your password';
  password.minLength = register || reset ? 10 : 1;
  $('#auth-form [name="confirmPassword"]').required = reset;
  $('#auth-error').textContent = '';
  $('#auth-status').hidden = true;
  $('#auth-status').textContent = '';
}

async function enterWithAuth(endpoint, data = {}) {
  const result = await api(endpoint, { method: 'POST', body: JSON.stringify(data) });
  state.user = result.user;
  state.csrfToken = result.csrfToken;
  showApp();
  const roomId = new URLSearchParams(location.search).get('room');
  if (roomId) { history.replaceState(null, '', '/'); await joinRoom(roomId); }
}

function setAuthStatus(message, kind = 'success') {
  const status = $('#auth-status');
  status.textContent = message;
  status.classList.toggle('error', kind === 'error');
  status.hidden = !message;
}

async function joinAsGuest(name, roomId) {
  const result = await api('/api/guest/session', { method: 'POST', body: JSON.stringify({ name, roomId }) });
  state.user = result.user;
  state.csrfToken = result.csrfToken;
  history.replaceState(null, '', '/');
  showApp();
  await joinRoom(roomId);
}

function renderPage(page) {
  if (page === 'admin' && state.user?.role !== 'admin') {
    toast('You do not have access to the admin dashboard.', 'error');
    page = 'home';
  }
  leaveCurrentPage();
  state.currentPage = page;
  $('#home-page').hidden = page !== 'home';
  $('#meeting-page').hidden = page !== 'meeting';
  $('#secondary-page').hidden = page === 'home' || page === 'meeting';
  $('#secondary-page').classList.toggle('admin-view', page === 'admin');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === page));
  if (page === 'meeting') $('#breadcrumb-page').textContent = 'In a meeting';
  else if (page === 'home') $('#breadcrumb-page').textContent = 'Home';
  else {
    const labels = { meetings: ['Meetings', 'The conversations that bring your team closer.'], files: ['Shared files', 'Everything your team has passed around, in one place.'], whiteboards: ['Whiteboards', 'A place to make the shape of an idea visible.'], admin: ['Admin dashboard', 'Workspace usage, accounts, and meeting activity.'] };
    const [title, description] = labels[page] || ['Home', ''];
    $('#breadcrumb-page').textContent = title;
    $('#secondary-title').textContent = title;
    $('#secondary-description').textContent = description;
    renderSecondary(page);
  }
}

function leaveCurrentPage() {
  if (state.currentPage === 'meeting' && state.room) teardownMeeting();
}


function renderSecondary(page) {
  const root = $('#secondary-content');
  root.replaceChildren();
  if (page === 'admin') {
    renderAdminDashboard(root);
    return;
  }
  const card = document.createElement('div');
  card.className = 'secondary-card';
  if (page === 'meetings') {
    const history = document.createElement('div');
    history.id = 'meeting-history';
    history.append(makeEmptyState('Loading your rooms...', 'Your meeting history will appear here.'));
    card.append(history);
    root.append(card);
    loadRoomHistory(history);
  } else if (page === 'files') {
    root.append(card);
    loadSharedFileLibrary(card);
  } else {
    card.append(makeEmptyState('Give your ideas somewhere to land.', 'Open a shared board in any meeting and start sketching together.', 'Start a meeting and open the board', 'board'));
    root.append(card);
  }
}

function renderAdminDashboard(container) {
  const dashboard = document.createElement('div');
  dashboard.className = 'admin-dashboard';
  dashboard.innerHTML = `
    <div class="admin-metrics" aria-label="Workspace metrics">
      <article class="admin-metric"><span>Total accounts</span><strong data-admin-metric="totalUsers">—</strong><small>Registered member accounts</small></article>
      <article class="admin-metric"><span>Active users</span><strong data-admin-metric="activeUsers">—</strong><small>Users with a current session</small></article>
      <article class="admin-metric"><span>Meeting rooms</span><strong data-admin-metric="totalRooms">—</strong><small>Saved room history</small></article>
      <article class="admin-metric"><span>Live rooms</span><strong data-admin-metric="activeRooms">—</strong><small>Rooms with participants now</small></article>
      <article class="admin-metric"><span>Participants</span><strong data-admin-metric="liveParticipants">—</strong><small>Connected room members</small></article>
    </div>
    <div class="admin-toolbar"><p data-admin-error role="alert" hidden></p><span data-admin-updated>Loading workspace data…</span><button class="link-button" type="button" data-admin-refresh>Refresh data ↻</button></div>
    <section class="admin-card">
      <div class="admin-card-heading"><div><span class="eyebrow">ACCESS OVERVIEW</span><h2>Accounts</h2></div><span class="admin-count" data-admin-user-count>—</span></div>
      <div class="admin-table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Joined</th><th>Sessions</th><th>Rooms</th></tr></thead><tbody data-admin-users><tr><td colspan="5">Loading accounts…</td></tr></tbody></table></div>
    </section>
    <section class="admin-card">
      <div class="admin-card-heading"><div><span class="eyebrow">ROOM ACTIVITY</span><h2>Recent meetings</h2></div><span class="admin-count">Last 25</span></div>
      <div class="admin-table-wrap"><table><thead><tr><th>Room</th><th>Owner</th><th>Created</th><th>Members</th><th>Status</th></tr></thead><tbody data-admin-rooms><tr><td colspan="5">Loading rooms…</td></tr></tbody></table></div>
    </section>`;
  container.append(dashboard);
  dashboard.querySelector('[data-admin-refresh]').addEventListener('click', () => loadAdminOverview(dashboard));
  loadAdminOverview(dashboard);
}

function formatAdminDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function appendAdminCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = String(value ?? '—');
  row.append(cell);
  return cell;
}

function renderAdminRows(dashboard, data) {
  for (const [key, value] of Object.entries(data.metrics || {})) {
    const metric = dashboard.querySelector(`[data-admin-metric="${key}"]`);
    if (metric) metric.textContent = Number(value || 0).toLocaleString();
  }
  const userBody = dashboard.querySelector('[data-admin-users]');
  userBody.replaceChildren();
  dashboard.querySelector('[data-admin-user-count]').textContent = `${(data.users || []).length} shown`;
  if (!data.users?.length) {
    const row = document.createElement('tr'); appendAdminCell(row, 'No accounts yet.').colSpan = 5; userBody.append(row);
  } else {
    for (const account of data.users) {
      const row = document.createElement('tr');
      const accountCell = document.createElement('td');
      accountCell.innerHTML = '<strong></strong><small></small>';
      accountCell.querySelector('strong').textContent = account.name || 'Unnamed account';
      accountCell.querySelector('small').textContent = account.email || 'No email';
      row.append(accountCell);
      const roleCell = appendAdminCell(row, '');
      const roleBadge = document.createElement('span'); roleBadge.className = `admin-role ${account.role === 'admin' ? 'is-admin' : ''}`; roleBadge.textContent = account.role || 'member'; roleCell.append(roleBadge);
      appendAdminCell(row, formatAdminDate(account.createdAt));
      const sessionsCell = appendAdminCell(row, account.activeSessions ? `${account.activeSessions} active` : '—');
      if (account.activeSessions) sessionsCell.classList.add('admin-session-active');
      appendAdminCell(row, account.roomCount || 0);
      userBody.append(row);
    }
  }

  const roomBody = dashboard.querySelector('[data-admin-rooms]');
  roomBody.replaceChildren();
  if (!data.rooms?.length) {
    const row = document.createElement('tr'); appendAdminCell(row, 'No meeting rooms yet.').colSpan = 5; roomBody.append(row);
  } else {
    for (const room of data.rooms) {
      const row = document.createElement('tr');
      const roomCell = document.createElement('td');
      roomCell.innerHTML = '<strong></strong><small></small>';
      roomCell.querySelector('strong').textContent = room.name || 'Meeting room';
      roomCell.querySelector('small').textContent = `Code ${room.id}`;
      row.append(roomCell);
      appendAdminCell(row, room.owner || 'Unknown');
      appendAdminCell(row, formatAdminDate(room.createdAt));
      appendAdminCell(row, room.memberCount || 0);
      const statusCell = appendAdminCell(row, '');
      const badge = document.createElement('span');
      badge.className = `admin-room-status ${room.activeParticipants ? 'is-live' : ''}`;
      badge.textContent = room.activeParticipants ? `${room.activeParticipants} live` : 'Quiet';
      statusCell.append(badge);
      roomBody.append(row);
    }
  }
}

async function loadAdminOverview(dashboard) {
  const error = dashboard.querySelector('[data-admin-error]');
  const updated = dashboard.querySelector('[data-admin-updated]');
  const refresh = dashboard.querySelector('[data-admin-refresh]');
  error.hidden = true;
  refresh.disabled = true;
  refresh.textContent = 'Refreshing…';
  try {
    const data = await api('/api/admin/overview');
    renderAdminRows(dashboard, data);
    updated.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    updated.textContent = 'Dashboard data unavailable';
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh data ↻';
  }
}

async function fetchWorkspaceRooms() {
  const { rooms } = await api('/api/rooms');
  return rooms;
}

function makeEmptyState(title, description, buttonLabel = 'Start a meeting', action = 'meeting') {
  const empty = document.createElement('div'); empty.className = 'secondary-empty';
  const heading = document.createElement('strong'); heading.textContent = title;
  const copy = document.createElement('p'); copy.textContent = description;
  const button = document.createElement('button'); button.className = 'button button-primary'; button.type = 'button'; button.dataset.openAction = action;
  button.style.cssText = 'height:32px;padding:0 10px;font-size:9px'; button.textContent = buttonLabel;
  empty.append(heading, copy, button);
  return empty;
}

function createRoomCard(room, compact = false) {
  const date = new Date(room.createdAt);
  const validDate = !Number.isNaN(date.getTime());
  if (compact) {
    const row = document.createElement('div'); row.className = 'secondary-list-item';
    const icon = document.createElement('span'); icon.className = 'secondary-list-icon'; icon.textContent = '#';
    const copy = document.createElement('div'); copy.className = 'secondary-list-copy';
    const name = document.createElement('strong'); name.textContent = room.name;
    const detail = document.createElement('small');
    detail.textContent = (validDate ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Meeting room') + ' · Code ' + room.id;
    const join = document.createElement('button'); join.type = 'button'; join.dataset.joinRoomId = room.id; join.textContent = 'Join';
    copy.append(name, detail); row.append(icon, copy, join); return row;
  }

  const article = document.createElement('article'); article.className = 'event-card room-event';
  const dateBox = document.createElement('div'); dateBox.className = 'event-date';
  const day = document.createElement('strong'); day.textContent = validDate ? String(date.getDate()).padStart(2, '0') : '—';
  const month = document.createElement('span'); month.textContent = validDate ? date.toLocaleString([], { month: 'short' }).toUpperCase() : 'ROOM';
  dateBox.append(day, month);
  const info = document.createElement('div'); info.className = 'event-info';
  const titleRow = document.createElement('div'); titleRow.className = 'event-title-row';
  const title = document.createElement('strong'); title.textContent = room.name; titleRow.append(title);
  if (room.participantCount > 0) {
    const live = document.createElement('span'); live.className = 'event-live';
    const dot = document.createElement('i'); live.append(dot, document.createTextNode(' LIVE NOW')); titleRow.append(live);
  }
  const owner = document.createElement('p'); owner.textContent = room.owner === state.user?.name ? 'Created by you' : 'Created by ' + room.owner;
  const meta = document.createElement('div'); meta.className = 'event-meta';
  const created = document.createElement('span'); created.textContent = validDate ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Meeting room';
  const people = document.createElement('span'); people.textContent = room.participantCount + ' ' + (room.participantCount === 1 ? 'person' : 'people') + ' active';
  meta.append(created, people); info.append(titleRow, owner, meta);
  const join = document.createElement('button'); join.className = 'event-join'; join.type = 'button'; join.dataset.joinRoomId = room.id;
  join.append(document.createTextNode('Join '));
  const arrow = document.createElement('span'); arrow.textContent = '↗'; join.append(arrow);
  article.append(dateBox, info, join); return article;
}

function renderWorkspaceRooms(rooms) {
  const roomCount = $('#room-count');
  if (roomCount) { roomCount.textContent = String(rooms.length); roomCount.hidden = rooms.length === 0; }
  const list = $('#home-room-list');
  if (list) {
    list.replaceChildren();
    if (!rooms.length) list.append(makeEmptyState('Your first room is ready.', 'Start a call and invite your team to join.'));
    else rooms.slice(0, 4).forEach((room) => list.append(createRoomCard(room)));
  }

  const links = $('#workspace-room-links');
  if (!links) return;
  links.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement('small'); empty.className = 'nav-room-empty'; empty.textContent = 'Your rooms appear here'; links.append(empty); return;
  }
  rooms.slice(0, 5).forEach((room) => {
    const button = document.createElement('button'); button.className = 'room-link'; button.type = 'button'; button.dataset.joinRoomId = room.id;
    const hash = document.createElement('span'); hash.className = 'room-hash'; hash.textContent = '#';
    const name = document.createElement('span'); name.className = 'room-link-name'; name.textContent = `${room.name} · ${room.id.slice(-4)}`;
    button.title = `${room.name} · Room code ${room.id}`;
    button.append(hash, name);
    if (room.participantCount > 0) { const presence = document.createElement('i'); presence.className = 'room-presence'; button.append(presence); }
    links.append(button);
  });
}

function renderMeetingHistory(container, rooms) {
  container.replaceChildren();
  if (!rooms.length) { container.append(makeEmptyState('No meeting rooms yet.', 'Create a room and share its link or code with your team.')); return; }
  rooms.forEach((room) => container.append(createRoomCard(room, true)));
}

async function refreshWorkspaceRooms() {
  if (!state.user) return [];
  try {
    const rooms = await fetchWorkspaceRooms();
    renderWorkspaceRooms(rooms);
    return rooms;
  } catch (error) {
    const list = $('#home-room-list');
    if (list) list.replaceChildren(makeEmptyState('Could not load meeting rooms.', error.message, 'Retry', 'retryRooms'));
    return [];
  }
}

async function loadRoomHistory(container) {
  try { renderMeetingHistory(container, await fetchWorkspaceRooms()); }
  catch (error) { container.replaceChildren(makeEmptyState('Could not load meetings.', error.message, 'Retry', 'retryMeetings')); }
}

const FILE_DATABASE = 'meeting-files';
function openFileDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('This browser does not support local file storage.'));
    const request = indexedDB.open(FILE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('sharedFiles')) request.result.createObjectStore('sharedFiles', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local file storage.'));
  });
}

async function rememberFile(file) {
  const record = {
    id: crypto.randomUUID(), ownerId: state.user?.id || '', roomId: state.room?.id || '',
    name: String(file.name || 'Shared file').slice(0, 180), size: Number(file.size) || 0,
    type: file.type || 'application/octet-stream', blob: file.blob, createdAt: new Date().toISOString(),
  };
  try {
    const database = await openFileDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('sharedFiles', 'readwrite');
        transaction.objectStore('sharedFiles').put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not save this file locally.'));
        transaction.onabort = () => reject(transaction.error || new Error('Could not save this file locally.'));
      });
    } finally { database.close(); }
  } catch (error) {
    console.warn('File was shared but could not be added to the local library.', error);
    toast('File was shared, but this browser could not save it in your file library.', 'error');
  }
  return record;
}

async function loadSharedFileLibrary(container) {
  container.replaceChildren(makeEmptyState('Loading shared files...', 'Your locally saved meeting files will appear here.'));
  let database;
  try {
    database = await openFileDatabase();
    const files = await new Promise((resolve, reject) => {
      const request = database.transaction('sharedFiles', 'readonly').objectStore('sharedFiles').getAll();
      request.onsuccess = () => resolve(request.result.filter((file) => file.ownerId === state.user?.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      request.onerror = () => reject(request.error || new Error('Could not read shared files.'));
    });
    database.close(); database = null;
    container.replaceChildren();
    if (!files.length) { container.append(makeEmptyState('No files shared yet.', 'Share a file while you are in a meeting.')); return; }
    for (const file of files) {
      const row = document.createElement('div'); row.className = 'secondary-list-item';
      const icon = document.createElement('span'); icon.className = 'secondary-list-icon'; icon.textContent = '↧';
      const copy = document.createElement('div'); copy.className = 'secondary-list-copy';
      const name = document.createElement('strong'); name.textContent = file.name;
      const date = new Date(file.createdAt);
      const detail = document.createElement('small'); detail.textContent = formatBytes(file.size) + ' · ' + date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      const download = document.createElement('a'); download.className = 'link-button'; download.href = URL.createObjectURL(file.blob); download.download = file.name; download.textContent = 'Download ↗';
      copy.append(name, detail); row.append(icon, copy, download); container.append(row);
    }
  } catch (error) {
    if (database) database.close();
    container.replaceChildren(makeEmptyState('File library unavailable.', error.message, 'Start a meeting'));
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function escapeAttr(value) { return escapeHtml(value); }

function openModal(id) {
  closeModal();
  $('#modal-backdrop').hidden = false;
  $(`#${id}`).hidden = false;
  const field = $(`#${id} input:not([readonly])`);
  window.setTimeout(() => field?.focus(), 30);
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
  $$('.modal-card').forEach((modal) => { modal.hidden = true; });
}

async function createAndJoinRoom(name = 'Quick team sync') {
  try {
    const { room } = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    await joinRoom(room.id);
  } catch (error) { toast(error.message, 'error'); }
}

async function joinRoom(roomId) {
  if (state.room) teardownMeeting();
  try {
    const { room } = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    const iceConfig = await api('/api/ice-config');
    if (Array.isArray(iceConfig.iceServers) && iceConfig.iceServers.length) state.iceServers = iceConfig.iceServers;
    state.room = room;
    state.peerId = crypto.randomUUID();
    $('#meeting-name').textContent = room.name;
    $('#meeting-code').textContent = `ROOM · ${room.id}`;
    $('#local-label').textContent = `${state.user.name} (You)`;
    $('#local-initials').textContent = state.user.initials;
    renderPage('meeting');
    let mediaError = null;
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      $('#local-video').srcObject = state.localStream;
      $('#local-video').style.display = 'block';
      $('#local-placeholder').style.display = 'none';
    } catch (error) {
      mediaError = error;
      $('#local-video').style.display = 'none';
      $('#local-placeholder').style.display = 'grid';
      if (error.name !== 'NotAllowedError' && error.name !== 'NotFoundError') console.warn('Camera or microphone is unavailable', error);
    }
    const joined = await api(`/api/rooms/${room.id}/join`, { method: 'POST', body: JSON.stringify({ peerId: state.peerId }) });
    $('#local-label').textContent = `${joined.self.name} (You)`;
    for (const peer of joined.peers) await addPeer(peer);
    state.startedAt = Date.now();
    updateMeetingUI();
    startMeetingTimers();
    connectRoomSocket();
    await syncPeers();
    refreshWorkspaceRooms();
    if (mediaError?.name === 'NotAllowedError') toast('Camera and microphone are off. You can still join and use chat.', 'error');
    else toast(`You're in ${room.name}.`);
  } catch (error) {
    if (state.currentPage === 'meeting') renderPage('home');
    state.room = null;
    toast(error.message, 'error');
  }
}

function startMeetingTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.presenceTimer);
  clearInterval(state.clockTimer);
  state.pollTimer = window.setInterval(pollMeeting, 1100);
  state.presenceTimer = window.setInterval(() => {
    if (state.room) api(`/api/rooms/${state.room.id}/presence`, { method: 'POST', body: JSON.stringify({ peerId: state.peerId }) }).catch(() => {});
  }, 6000);
  state.clockTimer = window.setInterval(updateClock, 1000);
  updateClock();
}

function updateClock() {
  if (!state.startedAt) return;
  const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
  $('#meeting-clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function pollMeeting() {
  if (!state.room) return;
  await Promise.all([syncPeers(), receiveSignals()]);
}

async function syncPeers() {
  if (!state.room) return;
  try {
    const { peers } = await api(`/api/rooms/${state.room.id}/peers?peerId=${encodeURIComponent(state.peerId)}`);
    const currentIds = new Set(peers.map((peer) => peer.id));
    for (const peer of peers) {
      if (peer.id === state.peerId) continue;
      if (!state.connections.has(peer.id)) await addPeer(peer);
    }
    for (const [peerId, connection] of state.connections) {
      if (!currentIds.has(peerId)) {
        connection.close();
        state.connections.delete(peerId);
        state.remotePeers.delete(peerId);
        $(`[data-peer-id="${CSS.escape(peerId)}"]`)?.remove();
      }
    }
    updateMeetingUI();
  } catch (error) {
    if (error.message.includes('session')) { toast(error.message, 'error'); await signOut(false); }
  }
}

async function addPeer(peer) {
  if (!state.room || state.connections.has(peer.id)) return;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const entry = { pc, peer, channel: null, stream: new MediaStream(), pendingCandidates: [] };
  state.connections.set(peer.id, entry);
  state.remotePeers.set(peer.id, peer);
  if (state.localStream) state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(peer.id, 'candidate', event.candidate.toJSON());
  };
  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) entry.stream = stream;
    else if (!entry.stream.getTracks().some((track) => track.id === event.track.id)) entry.stream.addTrack(event.track);
    renderRemoteTile(peer, entry.stream);
  };
  pc.ondatachannel = (event) => attachDataChannel(entry, event.channel);
  pc.onconnectionstatechange = () => {
    updateMeetingUI();
    if (pc.connectionState === 'failed') toast(`Could not connect to ${peer.name}. Try joining on the same network or configure a TURN relay.`, 'error');
  };
  if (state.peerId.localeCompare(peer.id) < 0) {
    attachDataChannel(entry, pc.createDataChannel('meeting-room', { ordered: true }));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(peer.id, 'offer', pc.localDescription.toJSON());
    } catch (error) { console.error('Unable to create call offer', error); }
  }
}

function attachDataChannel(entry, channel) {
  entry.channel = channel;
  channel.onopen = () => {
    updateMeetingUI();
    if (state.boardStrokes.length) {
      try { channel.send(JSON.stringify({ kind: 'whiteboard:snapshot', strokes: state.boardStrokes })); } catch {}
    }
  };
  channel.onmessage = (event) => handleRoomMessage(entry.peer, event.data);
  channel.onclose = updateMeetingUI;
}

function joinSocketRoom() {
  if (!state.socket?.connected || !state.room || !state.peerId) return;
  state.socket.emit('room:join', { roomId: state.room.id, peerId: state.peerId }, (result) => {
    if (!result?.ok) { console.warn('Socket.IO signaling could not join this room', result?.error); return; }
    receiveSignals(true);
  });
}

function connectRoomSocket() {
  if (typeof window.io !== 'function' || !state.room) return;
  if (!state.socket) {
    state.socket = window.io({ autoConnect: false, auth: { csrfToken: state.csrfToken } });
    state.socket.on('connect', joinSocketRoom);
    state.socket.on('room:peer-joined', (peer) => {
      if (peer.id !== state.peerId && !state.connections.has(peer.id)) addPeer(peer);
    });
    state.socket.on('room:peer-left', ({ id }) => removePeer(id));
    state.socket.on('room:signal', (signal) => processSignal(signal));
    state.socket.on('connect_error', (error) => console.info('Socket.IO unavailable; using HTTP signaling.', error.message));
  }
  state.socket.auth = { csrfToken: state.csrfToken };
  if (state.socket.connected) joinSocketRoom(); else state.socket.connect();
}

async function sendSignal(to, type, payload) {
  if (!state.room) return;
  if (state.socket?.connected) {
    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } };
      const timeout = window.setTimeout(() => finish(null), 2500);
      state.socket.emit('room:signal', { roomId: state.room.id, from: state.peerId, to, type, payload }, finish);
    });
    if (result?.delivered) return;
  }
  try {
    await api(`/api/rooms/${state.room.id}/signals`, { method: 'POST', body: JSON.stringify({ from: state.peerId, to, type, payload }) });
  } catch (error) { console.warn('Call signal was not delivered', error); }
}

async function receiveSignals(force = false) {
  if (state.socket?.connected && !force) return;
  try {
    const { signals } = await api(`/api/rooms/${state.room.id}/signals?peerId=${encodeURIComponent(state.peerId)}`);
    for (const signal of signals) await processSignal(signal);
  } catch (error) {
    if (error.message.includes('session')) { toast(error.message, 'error'); await signOut(false); }
  }
}

async function processSignal(signal) {
  if (!state.room) return;
  if (!state.connections.has(signal.from)) {
    const { peers } = await api(`/api/rooms/${state.room.id}/peers?peerId=${encodeURIComponent(state.peerId)}`);
    const peer = peers.find((item) => item.id === signal.from);
    if (peer) await addPeer(peer);
  }
  const entry = state.connections.get(signal.from);
  if (!entry) return;
  try {
    if (signal.type === 'offer') {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
      while (entry.pendingCandidates.length) await entry.pc.addIceCandidate(new RTCIceCandidate(entry.pendingCandidates.shift()));
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      await sendSignal(signal.from, 'answer', entry.pc.localDescription.toJSON());
    } else if (signal.type === 'answer') {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
      while (entry.pendingCandidates.length) await entry.pc.addIceCandidate(new RTCIceCandidate(entry.pendingCandidates.shift()));
    } else if (signal.type === 'candidate') {
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(new RTCIceCandidate(signal.payload));
      else entry.pendingCandidates.push(signal.payload);
    }
  } catch (error) { console.warn('Call signal could not be applied', error); }
}

function renderRemoteTile(peer, stream) {
  let tile = $(`[data-peer-id="${CSS.escape(peer.id)}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile remote-tile';
    tile.dataset.peerId = peer.id;
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.srcObject = stream;
    const placeholder = document.createElement('div'); placeholder.className = 'tile-placeholder';
    placeholder.innerHTML = '<span class="tile-person"></span>';
    const label = document.createElement('div'); label.className = 'tile-label';
    label.innerHTML = `<span class="mic-status">♫</span><span>${escapeHtml(peer.name)}</span><span class="tile-speaking-dot"></span>`;
    tile.append(video, placeholder, label);
    $('#stage-grid').append(tile);
  } else {
    const video = $('video', tile); if (video.srcObject !== stream) video.srcObject = stream;
  }
  $('video', tile).style.display = 'block';
  $('.tile-placeholder', tile).style.display = 'none';
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onmute = () => { $('video', tile).style.display = 'none'; $('.tile-placeholder', tile).style.display = 'grid'; };
    videoTrack.onunmute = () => { $('video', tile).style.display = 'block'; $('.tile-placeholder', tile).style.display = 'none'; };
  }
  updateMeetingUI();
}

function removePeer(peerId) {
  const connection = state.connections.get(peerId);
  connection?.close();
  state.connections.delete(peerId);
  state.remotePeers.delete(peerId);
  $(`[data-peer-id="${CSS.escape(peerId)}"]`)?.remove();
  updateMeetingUI();
}

function updateMeetingUI() {
  if (!state.room) return;
  const count = 1 + state.connections.size;
  $('#participant-count').textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
  $('#people-tab-count').textContent = count;
  $('#people-heading-count').textContent = count;
  $('#stage-empty').hidden = count > 1;
  const connectionStates = [...state.connections.values()].map((entry) => entry.pc.connectionState);
  const connectionText = !connectionStates.length ? 'Waiting for teammates'
    : connectionStates.includes('failed') ? 'Connection issue'
      : connectionStates.every((status) => status === 'connected') ? 'Connected securely'
        : 'Connecting to teammates';
  $('#connection-status span').textContent = connectionText;
  $('#connection-status').classList.toggle('connection-warning', connectionText === 'Connection issue');
  renderPeople();
  $('#toggle-mic').classList.toggle('off', !state.micOn);
  $('#toggle-mic').classList.toggle('active', state.micOn);
  $('#toggle-mic small').textContent = state.micOn ? 'Mute' : 'Unmute';
  $('#local-mic-status').textContent = state.micOn ? '♫' : '×';
  $('#toggle-camera').classList.toggle('off', !state.cameraOn);
  $('#toggle-camera').classList.toggle('active', state.cameraOn);
  $('#toggle-camera small').textContent = state.cameraOn ? 'Stop video' : 'Start video';
  $('#share-screen').classList.toggle('active', state.screenSharing);
}

function renderPeople() {
  const list = $('#people-list');
  if (!list) return;
  const everyone = [{ id: state.peerId, name: state.user.name, initials: state.user.initials, self: true }, ...state.remotePeers.values()];
  list.innerHTML = '<div class="people-section-label">IN THE ROOM · ' + everyone.length + '</div>';
  for (const person of everyone) {
    const row = document.createElement('div'); row.className = 'person-row';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = person.initials || person.name.slice(0, 1).toUpperCase();
    const copy = document.createElement('span'); copy.className = 'person-copy';
    copy.innerHTML = `<strong>${escapeHtml(person.name)}${person.self ? ' (You)' : ''}</strong><small>${person.self ? 'Meeting host' : 'In this room'}</small>`;
    const presence = document.createElement('i'); presence.className = 'person-presence';
    row.append(avatar, copy, presence); list.append(row);
  }
  if (everyone.length === 1) list.insertAdjacentHTML('beforeend', '<div class="secondary-empty"><strong>Room for one more.</strong><p>Invite someone and get the conversation going.</p></div>');
}

function teardownMeeting() {
  clearInterval(state.pollTimer); clearInterval(state.presenceTimer); clearInterval(state.clockTimer);
  state.pollTimer = state.presenceTimer = state.clockTimer = null;
  if (state.room && state.peerId && state.socket?.connected) state.socket.emit('room:leave', { roomId: state.room.id, peerId: state.peerId });
  if (state.room && state.peerId) api(`/api/rooms/${state.room.id}/leave`, { method: 'POST', body: JSON.stringify({ peerId: state.peerId }) }).catch(() => {});
  for (const connection of state.connections.values()) connection.close();
  state.connections.clear(); state.remotePeers.clear();
  state.localStream?.getTracks().forEach((track) => track.stop()); state.localStream = null;
  state.screenStream?.getTracks().forEach((track) => track.stop()); state.screenStream = null;
  $('#local-video').srcObject = null;
  $$('.remote-tile', $('#stage-grid')).forEach((tile) => tile.remove());
  $('#meeting-page').hidden = true;
  $('#whiteboard-modal').hidden = true;
  state.peerId = ''; state.startedAt = 0; state.screenSharing = false;
  state.boardStrokes = [];
  state.room = null;
}

async function leaveMeeting() {
  if (state.room) teardownMeeting();
  state.currentPage = 'home';
  renderPage('home');
  refreshWorkspaceRooms();
  toast('You left the meeting.');
}

function selectTab(tab) {
  state.activeTab = tab;
  $('#chat-panel').hidden = tab !== 'chat';
  $('#people-panel').hidden = tab !== 'people';
  $$('.aside-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  if (tab === 'chat') { state.unread = false; $('#chat-dot').hidden = true; $('#chat-tab-dot').hidden = true; }
}

function sendRoomMessage(message) {
  const payload = { kind: 'chat', id: crypto.randomUUID(), sender: state.user.name, initials: state.user.initials, text: message, timestamp: Date.now() };
  if (state.connections.size && [...state.connections.values()].some((entry) => entry.channel?.readyState !== 'open')) {
    toast('Your room connection is still starting. Try again in a moment.', 'error');
    return false;
  }
  broadcast(payload);
  displayChatMessage(payload, true);
  return true;
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  let sent = 0;
  for (const entry of state.connections.values()) {
    if (entry.channel?.readyState === 'open') {
      try { entry.channel.send(message); sent++; } catch (error) { console.warn('A room message could not be sent', error); }
    }
  }
  return sent;
}

function handleRoomMessage(peer, raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload.kind === 'chat') {
    displayChatMessage({ ...payload, sender: peer.name, initials: peer.initials }, false);
    if (!state.chatOpen || state.activeTab !== 'chat') { state.unread = true; $('#chat-dot').hidden = false; $('#chat-tab-dot').hidden = false; }
  } else if (payload.kind === 'whiteboard:stroke') drawRemoteStroke(payload);
  else if (payload.kind === 'whiteboard:snapshot' && Array.isArray(payload.strokes)) {
    const strokes = new Map(state.boardStrokes.map((stroke) => [stroke.id, stroke]));
    for (const stroke of payload.strokes) if (stroke?.id && Array.isArray(stroke.points)) strokes.set(stroke.id, stroke);
    state.boardStrokes = [...strokes.values()];
    if (!$('#whiteboard-modal').hidden) redrawBoard();
  }
  else if (payload.kind === 'whiteboard:clear') clearBoard(false);
  else if (payload.kind === 'file:start') {
    const expectedChunks = Math.max(1, Math.ceil(payload.size / (12 * 1024)));
    if (typeof payload.id !== 'string' || payload.id.length > 64 || !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > 10 * 1024 * 1024 || payload.chunks !== expectedChunks) return;
    state.fileTransfers.set(payload.id, { name: String(payload.name || 'Shared file').slice(0, 180), type: String(payload.type || 'application/octet-stream').slice(0, 120), size: payload.size, senderName: peer.name, senderInitials: peer.initials, chunks: new Array(payload.chunks), received: 0 });
  } else if (payload.kind === 'file:chunk') receiveFileChunk(payload).catch((error) => toast(error.message, 'error'));
}

function displayChatMessage(message, own) {
  const container = $('#chat-messages');
  $('.chat-welcome', container)?.remove();
  const row = document.createElement('article'); row.className = 'chat-message';
  const avatar = document.createElement('span'); avatar.className = `avatar ${own ? 'avatar-mint' : 'avatar-lilac'}`; avatar.textContent = message.initials || '??';
  const body = document.createElement('div'); body.className = 'message-body';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = own ? 'You' : message.sender;
  const time = document.createElement('time'); time.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const text = document.createElement('p'); text.textContent = message.text;
  meta.append(name, time); body.append(meta, text); row.append(avatar, body); container.append(row); container.scrollTop = container.scrollHeight;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sendFile(file) {
  if (!state.connections.size) return toast('Invite someone before sharing a file.', 'error');
  if ([...state.connections.values()].some((entry) => entry.channel?.readyState !== 'open')) return toast('Wait for everyone’s room connection before sharing a file.', 'error');
  if (file.size > 10 * 1024 * 1024) return toast('Files can be up to 10 MB.', 'error');
  const id = crypto.randomUUID();
  const chunkSize = 12 * 1024;
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
  broadcast({ kind: 'file:start', id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, chunks: total });
  for (let index = 0; index < total; index++) {
    const piece = bytes.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, bytes.length));
    let binary = '';
    for (let start = 0; start < piece.length; start += 8192) binary += String.fromCharCode(...piece.subarray(start, Math.min(start + 8192, piece.length)));
    broadcast({ kind: 'file:chunk', id, index, data: btoa(binary), last: index === total - 1 });
    await waitForDataChannels();
  }
  await rememberFile({ name: file.name, size: file.size, type: file.type, blob: file });
  const url = URL.createObjectURL(file);
  displayChatMessage({ sender: 'You', initials: state.user.initials, text: `Shared a file: ${file.name} (${formatBytes(file.size)})`, timestamp: Date.now() }, true);
  toast(`${file.name} shared with the room.`);
}

function waitForDataChannels() {
  const busy = [...state.connections.values()].filter((entry) => entry.channel?.readyState === 'open' && entry.channel.bufferedAmount > 512 * 1024);
  if (!busy.length) return Promise.resolve();
  return new Promise((resolve) => {
    let remaining = busy.length;
    for (const entry of busy) {
      entry.channel.bufferedAmountLowThreshold = 128 * 1024;
      entry.channel.onbufferedamountlow = () => { if (--remaining === 0) resolve(); };
    }
  });
}


async function receiveFileChunk(payload) {
  const transfer = state.fileTransfers.get(payload.id);
  if (!transfer || !Number.isSafeInteger(payload.index) || payload.index < 0 || payload.index >= transfer.chunks.length || typeof payload.data !== 'string' || transfer.chunks[payload.index]) return;
  let binary;
  try { binary = atob(payload.data); } catch { return; }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > 12 * 1024) return;
  transfer.chunks[payload.index] = bytes;
  transfer.received++;
  if (transfer.received < transfer.chunks.length) return;
  const blob = new Blob(transfer.chunks, { type: transfer.type });
  const url = URL.createObjectURL(blob);
  await rememberFile({ name: transfer.name, size: transfer.size, type: transfer.type, blob });
  const initials = transfer.senderInitials || '??';
  displayChatMessage({ sender: transfer.senderName || 'A teammate', initials, text: 'Shared a file: ' + transfer.name + ' (' + formatBytes(transfer.size) + ')', timestamp: Date.now() }, false);
  const lastMessage = $('.chat-message:last-child .message-body');
  const link = document.createElement('a'); link.className = 'message-file'; link.href = url; link.download = transfer.name;
  const icon = document.createElement('span'); icon.textContent = '↧';
  const label = document.createElement('span'); label.textContent = transfer.name + ' · ' + formatBytes(transfer.size);
  link.append(icon, label); lastMessage.append(link);
  state.fileTransfers.delete(payload.id);
  toast(transfer.name + ' is ready to download.');
}
function setCameraVideo() {
  const track = state.localStream?.getVideoTracks()[0];
  if (track) track.enabled = state.cameraOn;
  if (!track && state.cameraOn) ensureMedia('video');
  if (!state.cameraOn) { $('#local-video').style.display = 'none'; $('#local-placeholder').style.display = 'grid'; }
  else if (track) { $('#local-video').style.display = 'block'; $('#local-placeholder').style.display = 'none'; }
}

async function ensureMedia(kind) {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera access requires a secure context such as localhost or HTTPS.', 'error');
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true, video: false } : { audio: false, video: true });
    if (!state.localStream) state.localStream = stream; else stream.getTracks().forEach((track) => state.localStream.addTrack(track));
    $('#local-video').srcObject = state.localStream;
    $('#local-video').style.display = 'block'; $('#local-placeholder').style.display = 'none';
    for (const entry of state.connections.values()) {
      for (const track of stream.getTracks()) entry.pc.addTrack(track, stream);
      const offer = await entry.pc.createOffer(); await entry.pc.setLocalDescription(offer); await sendSignal(entry.peer.id, 'offer', entry.pc.localDescription.toJSON());
    }
  } catch (error) { toast(`Could not access ${kind}: ${error.message}`, 'error'); }
}

async function toggleScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing requires HTTPS or localhost.', 'error');
  if (state.screenSharing) return stopScreenShare();
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = state.screenStream.getVideoTracks()[0];
    track.onended = stopScreenShare;
    state.screenSharing = true;
    $('#local-video').srcObject = state.screenStream;
    $('#local-video').style.display = 'block'; $('#local-placeholder').style.display = 'none';
    for (const entry of state.connections.values()) {
      const sender = entry.pc.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    }
    updateMeetingUI(); toast('You are sharing your screen.');
  } catch (error) { if (error.name !== 'NotAllowedError') toast(`Screen sharing failed: ${error.message}`, 'error'); }
}

async function stopScreenShare() {
  if (!state.screenSharing) return;
  state.screenSharing = false;
  state.screenStream?.getTracks().forEach((track) => track.stop()); state.screenStream = null;
  const cameraTrack = state.localStream?.getVideoTracks()[0] || null;
  for (const entry of state.connections.values()) {
    const sender = entry.pc.getSenders().find((item) => item.track?.kind === 'video');
    if (sender) await sender.replaceTrack(cameraTrack);
  }
  $('#local-video').srcObject = state.localStream;
  $('#local-video').style.display = cameraTrack && state.cameraOn ? 'block' : 'none';
  $('#local-placeholder').style.display = cameraTrack && state.cameraOn ? 'none' : 'grid';
  updateMeetingUI();
}

function openWhiteboard() {
  $('#whiteboard-modal').hidden = false;
  resizeCanvas();
}

function resizeCanvas() {
  const canvas = $('#whiteboard-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext('2d'); context.scale(dpr, dpr); context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = 3;
  redrawBoard();
}

function canvasPoint(event) {
  const rect = $('#whiteboard-canvas').getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}

function startBoardStroke(event) {
  if (event.button !== 0) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  state.boardDrawing = true;
  state.currentStroke = [canvasPoint(event)];
}

function moveBoardStroke(event) {
  if (!state.boardDrawing) return;
  const point = canvasPoint(event); state.currentStroke.push(point);
  const canvas = $('#whiteboard-canvas'); const rect = canvas.getBoundingClientRect();
  const context = canvas.getContext('2d'); context.beginPath();
  const previous = state.currentStroke[state.currentStroke.length - 2];
  context.moveTo(previous.x * rect.width, previous.y * rect.height); context.lineTo(point.x * rect.width, point.y * rect.height);
  context.strokeStyle = state.boardErase ? '#ffffff' : state.boardColor; context.lineWidth = state.boardErase ? 20 : 3; context.stroke();
}

function endBoardStroke() {
  if (!state.boardDrawing) return;
  state.boardDrawing = false;
  if (state.currentStroke.length > 1) {
    const stroke = { id: crypto.randomUUID(), points: state.currentStroke, color: state.boardErase ? '#ffffff' : state.boardColor, width: state.boardErase ? 20 : 3 };
    state.boardStrokes.push(stroke);
    broadcast({ kind: 'whiteboard:stroke', ...stroke });
  }
  state.currentStroke = [];
}

function drawRemoteStroke(payload) {
  if (!Array.isArray(payload.points) || payload.points.length < 2) return;
  if (payload.id && !state.boardStrokes.some((stroke) => stroke.id === payload.id)) state.boardStrokes.push(payload);
  if (!$('#whiteboard-modal').hidden) paintBoardStroke(payload);
}

function paintBoardStroke(payload) {
  const canvas = $('#whiteboard-canvas'); const rect = canvas.getBoundingClientRect(); const context = canvas.getContext('2d');
  context.beginPath(); context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = payload.width || 3; context.strokeStyle = payload.color || '#456b4a';
  context.moveTo(payload.points[0].x * rect.width, payload.points[0].y * rect.height);
  for (const point of payload.points.slice(1)) context.lineTo(point.x * rect.width, point.y * rect.height);
  context.stroke();
}

function redrawBoard() {
  const canvas = $('#whiteboard-canvas');
  if (!canvas || !canvas.width || !canvas.height) return;
  const rect = canvas.getBoundingClientRect(); const context = canvas.getContext('2d');
  context.clearRect(0, 0, rect.width, rect.height);
  for (const stroke of state.boardStrokes) paintBoardStroke(stroke);
}

function clearBoard(announce = true) {
  const canvas = $('#whiteboard-canvas'); const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  state.boardStrokes = [];
  if (announce) broadcast({ kind: 'whiteboard:clear' });
}

function closeBoard() { $('#whiteboard-modal').hidden = true; }

async function copyText(value, label) {
  try { await navigator.clipboard.writeText(value); toast(`${label} copied.`); }
  catch { const input = $('#invite-link-input'); input.value = value; input.select(); document.execCommand('copy'); toast(`${label} copied.`); }
}

function inviteLink() { return state.room ? `${location.origin}/?room=${encodeURIComponent(state.room.id)}` : ''; }

function openInvite() {
  if (!state.room) return;
  $('#invite-link-input').value = inviteLink();
  $('#invite-room-code').textContent = state.room.id;
  openModal('invite-modal');
}

async function signOut(showToast = true) {
  try { if (state.csrfToken) await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  if (state.room) teardownMeeting();
  state.socket?.disconnect(); state.socket = null;
  state.user = null; state.csrfToken = '';
  showAuth();
  if (showToast) toast('You have signed out.');
}

function attachEvents() {
  $$('.theme-toggle').forEach((button) => button.addEventListener('click', () => setTheme(activeTheme === 'dark' ? 'light' : 'dark')));
  $('#auth-mode-toggle').addEventListener('click', () => {
    setAuthMode(state.authMode === 'register' ? 'login' : (state.authMode === 'login' ? 'register' : 'login'));
  });
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const data = Object.fromEntries(form.entries());
    $('#auth-error').textContent = '';
    setAuthStatus('');
    try {
      if (state.authMode === 'register') {
        const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: data.name, email: data.email, password: data.password }) });
        $('#auth-form [name="email"]').value = data.email;
        $('#auth-form [name="password"]').value = '';
        setAuthMode('login');
        setAuthStatus(result.delivery === 'console'
          ? 'Account created. Copy the verification link from the server terminal, then open it before signing in.'
          : `Account created. Check ${result.email || data.email} for a verification link before signing in.`);
      } else if (state.authMode === 'login') {
        await enterWithAuth('/api/auth/login', { email: data.email, password: data.password });
      } else if (state.authMode === 'forgot') {
        const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: data.email }) });
        setAuthStatus(result.delivery === 'console' ? `${result.message} In local development, any reset link appears in the server terminal.` : result.message);
      } else if (state.authMode === 'reset') {
        if (data.password !== data.confirmPassword) throw new Error('The passwords do not match.');
        const result = await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: state.resetToken, password: data.password }) });
        state.resetToken = '';
        history.replaceState(null, '', '/');
        setAuthMode('login');
        $('#auth-form [name="password"]').value = '';
        $('#auth-form [name="confirmPassword"]').value = '';
        setAuthStatus(result.message);
      }
    } catch (error) {
      if (state.authMode === 'forgot') setAuthStatus(error.message, 'error');
      else $('#auth-error').textContent = error.message;
    }
  });
  $('#forgot-password-link').addEventListener('click', () => {
    const email = $('#auth-form [name="email"]').value;
    setAuthMode('forgot');
    $('#auth-form [name="email"]').value = email;
  });
  $('#resend-verification-link').addEventListener('click', async () => {
    const email = $('#auth-form [name="email"]').value.trim();
    if (!email) { setAuthStatus('Enter your email address first.', 'error'); return; }
    try {
      const result = await api('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      setAuthStatus(result.delivery === 'console' ? `${result.message} In local development, any verification link appears in the server terminal.` : result.message);
    } catch (error) { setAuthStatus(error.message, 'error'); }
  });
  $('#guest-join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#guest-error').textContent = '';
    try {
      await joinAsGuest($('#guest-name').value.trim(), $('#guest-room-code').value.trim().toUpperCase());
    } catch (error) { $('#guest-error').textContent = error.message; }
  });
  $('.password-toggle').addEventListener('click', (event) => {
    const input = $('#auth-form [name="password"]'); input.type = input.type === 'password' ? 'text' : 'password'; event.currentTarget.textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
  $('#new-meeting').addEventListener('click', () => openModal('meeting-modal'));
  $('#workspace-info').addEventListener('click', () => toast('Studio North is your current workspace.'));
  $('#help-button').addEventListener('click', () => openModal('help-modal'));
  $('#help-privacy').addEventListener('click', () => openModal('security-modal'));
  $('#show-meetings').addEventListener('click', () => renderPage('meetings'));
  $('#hero-start').addEventListener('click', () => openModal('meeting-modal'));
  $('#quick-new').addEventListener('click', () => openModal('meeting-modal'));
  $('#hero-join').addEventListener('click', () => openModal('join-modal'));
  $('#quick-join').addEventListener('click', () => openModal('join-modal'));
  $('#meeting-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#meeting-error').textContent = '';
    const name = $('#room-name-input').value.trim() || 'Quick team sync'; closeModal(); await createAndJoinRoom(name);
  });
  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#join-error').textContent = '';
    const code = $('#room-code-input').value.trim().toUpperCase(); closeModal(); await joinRoom(code);
  });
  $('#quick-board').addEventListener('click', async () => { await createAndJoinRoom('Ideas workshop'); if (state.room) openWhiteboard(); });
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => renderPage(item.dataset.view)));
  $('#view-all-meetings').addEventListener('click', () => renderPage('meetings'));
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const joinButton = target?.closest('[data-join-room-id]');
    if (joinButton) { joinRoom(joinButton.dataset.joinRoomId); return; }
    const action = target?.closest('[data-open-action]')?.dataset.openAction;
    if (action === 'board') createAndJoinRoom('Ideas workshop').then(() => { if (state.room) openWhiteboard(); });
    else if (action === 'retryRooms') refreshWorkspaceRooms();
    else if (action === 'retryMeetings') loadRoomHistory($('#meeting-history'));
    else if (action === 'meeting') openModal('meeting-modal');
  });
  $('#add-room').addEventListener('click', () => openModal('meeting-modal'));
  $('#back-home').addEventListener('click', leaveMeeting);
  $('#leave-meeting').addEventListener('click', leaveMeeting);
  $('#meeting-invite').addEventListener('click', openInvite);
  $('#copy-room-code-shortcut').addEventListener('click', () => copyText(state.room?.id || '', 'Room code'));
  $('#chat-invite').addEventListener('click', openInvite);
  $('#empty-invite').addEventListener('click', openInvite);
  $('#people-invite').addEventListener('click', openInvite);
  $('#invite-teammate').addEventListener('click', () => state.room ? openInvite() : openModal('meeting-modal'));
  $('#copy-invite').addEventListener('click', () => copyText(inviteLink(), 'Invite link'));
  $('#copy-code').addEventListener('click', () => copyText(state.room?.id || '', 'Room code'));
  $('#toggle-mic').addEventListener('click', async () => {
    state.micOn = !state.micOn;
    const track = state.localStream?.getAudioTracks()[0];
    if (track) track.enabled = state.micOn;
    else if (state.micOn) await ensureMedia('audio');
    updateMeetingUI();
  });
  $('#toggle-camera').addEventListener('click', () => { state.cameraOn = !state.cameraOn; setCameraVideo(); updateMeetingUI(); });
  $('#share-screen').addEventListener('click', toggleScreenShare);
  $('#open-whiteboard').addEventListener('click', openWhiteboard);
  $('#close-whiteboard').addEventListener('click', closeBoard);
  $('#board-clear').addEventListener('click', () => clearBoard(true));
  $('#board-pen').addEventListener('click', () => { state.boardErase = false; $('#whiteboard-modal').classList.remove('erase-mode'); $('#board-pen').classList.add('active'); $('#board-erase').classList.remove('active'); });
  $('#board-erase').addEventListener('click', () => { state.boardErase = true; $('#whiteboard-modal').classList.add('erase-mode'); $('#board-erase').classList.add('active'); $('#board-pen').classList.remove('active'); });
  $('#whiteboard-canvas').addEventListener('pointerdown', startBoardStroke);
  $('#whiteboard-canvas').addEventListener('pointermove', moveBoardStroke);
  $('#whiteboard-canvas').addEventListener('pointerup', endBoardStroke);
  $('#whiteboard-canvas').addEventListener('pointercancel', endBoardStroke);
  $('#toggle-chat').addEventListener('click', () => { state.chatOpen = !state.chatOpen; $('#meeting-aside').hidden = !state.chatOpen; $('#toggle-chat').classList.toggle('active', state.chatOpen); });
  $('#toggle-participants').addEventListener('click', () => { state.chatOpen = true; $('#meeting-aside').hidden = false; selectTab('people'); });
  $('#close-aside').addEventListener('click', () => { state.chatOpen = false; $('#meeting-aside').hidden = true; });
  $$('.aside-tab').forEach((button) => button.addEventListener('click', () => { state.chatOpen = true; selectTab(button.dataset.tab); }));
  $('#send-message').addEventListener('click', submitChat);
  $('#chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitChat(); });
  $('#attach-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (file) { try { await sendFile(file); } catch (error) { toast(error.message, 'error'); } }
  });
  $('#meeting-security').addEventListener('click', () => openModal('security-modal'));
  $('#security-details').addEventListener('click', () => openModal('security-modal'));
  $('#profile-menu').addEventListener('click', openProfile);
  $('#topbar-avatar').addEventListener('click', openProfile);
  $('#sign-out').addEventListener('click', () => signOut());
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
  $('#modal-backdrop').addEventListener('click', (event) => { if (event.target === $('#modal-backdrop')) closeModal(); });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeModal(); if (!$('#whiteboard-modal').hidden) closeBoard(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openModal('meeting-modal'); }
  });
  window.addEventListener('resize', () => { if (!$('#whiteboard-modal').hidden) resizeCanvas(); });
  window.addEventListener('beforeunload', () => {
    if (state.room && state.peerId) fetch(`/api/rooms/${state.room.id}/leave`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: JSON.stringify({ peerId: state.peerId }) }).catch(() => {});
  });
}

function submitChat() {
  const input = $('#chat-input'); const text = input.value.trim();
  if (!text) return;
  if (sendRoomMessage(text)) input.value = '';
  input.focus();
}

function openProfile() {
  $('#profile-email').textContent = state.user?.guest ? 'Guest access · no account required' : (state.user?.email || '');
  openModal('profile-modal');
}

async function init() {
  initTheme();
  attachEvents();
  const query = new URLSearchParams(location.search);
  const linkToken = new URLSearchParams(location.hash.replace(/^#/, ''));
  const verificationToken = query.get('verify') || linkToken.get('verify');
  const resetToken = query.get('reset') || linkToken.get('reset');
  const roomCode = query.get('room');
  if (verificationToken) {
    history.replaceState(null, '', '/');
    showAuth('login');
    setAuthStatus('Checking your verification link...');
    try {
      await api('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verificationToken }) });
      setAuthStatus('Your email is verified. Sign in to continue.');
    } catch (error) { setAuthStatus(error.message, 'error'); }
    return;
  }
  if (resetToken) {
    history.replaceState(null, '', '/');
    state.resetToken = resetToken;
    showAuth('reset');
    return;
  }
  try {
    const session = await api('/api/session');
    state.user = session.user; state.csrfToken = session.csrfToken; showApp();
    if (roomCode) { history.replaceState(null, '', '/'); await joinRoom(roomCode); }
  } catch {
    showAuth();
    if (roomCode) $('#guest-room-code').value = roomCode.toUpperCase();
  }
}

init();
