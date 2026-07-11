'use strict';

// ─── STATE ───────────────────────────────────────────────────────
let ws = null;
const state = { connected: false, autoScroll: true, startTime: Date.now() };

// ─── DOM REFS ─────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const consoleOutput  = $('console-output');
const activityFeed   = $('activity-feed');
const playerList     = $('player-list');
const connectionBadge = $('connection-badge');
const statusLabel    = connectionBadge.querySelector('.status-label');

const TYPE_ICON = { join: '✅', leave: '🚶', death: '💀', chat: '💬', warn: '⚠️', error: '❌', system: '🔧', info: '📋' };
const TYPE_PREFIX = { join: 'JOIN', leave: 'LEAVE', death: 'DEATH', chat: 'CHAT', warn: 'WARN', error: 'ERROR', system: 'SYS', info: 'INFO' };

// ─── WEBSOCKET ────────────────────────────────────────────────────
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.addEventListener('open', () => {
    state.connected = true;
    setConnectionStatus('connected', 'Live');
    showToast('📡 Connected to server', 'join');
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    setConnectionStatus('disconnected', 'Disconnected');
    showToast('⚠️ Connection lost — retrying…', 'error');
    setTimeout(connect, 3000);
  });

  ws.addEventListener('error', () => setConnectionStatus('disconnected', 'Error'));

  ws.addEventListener('message', evt => {
    try { handleMessage(JSON.parse(evt.data)); }
    catch (e) { console.warn('[Dashboard] Bad WS message:', e); }
  });
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'init':
      applyServerInfo(data.serverInfo);
      data.consoleLogs.forEach(entry => appendLog(entry, false));
      data.activityFeed.forEach(entry => appendActivity(entry, false));
      updatePlayerList(data.serverInfo.players || []);
      scrollConsoleToBottom();
      break;
    case 'log':     appendLog(data.entry, true); break;
    case 'activity': appendActivity(data.entry, true); showPlayerToast(data.entry); break;
    case 'serverInfo': applyServerInfo(data.data); break;
  }
}

// ─── SERVER INFO ──────────────────────────────────────────────────
function applyServerInfo(info) {
  if (!info) return;
  setText('val-status', capitalise(info.status || 'online'));
  $('val-status').style.color = statusColor(info.status);
  setText('val-players', info.playerCount ?? 0);
  setText('val-maxplayers', info.maxPlayers ?? 20);
  setText('val-version', info.version || '—');
  setText('val-tps', formatTPS(info.tps));
  $('val-tps').style.color = tpsColor(info.tps);
  if (info.memory?.used) setText('val-mem-used', info.memory.used);
  if (info.players) updatePlayerList(info.players);
}

function statusColor(s) {
  if (!s) return '';
  if (s.includes('stop')) return 'var(--accent-red)';
  if (s.includes('start') || s.includes('load')) return 'var(--accent-yellow)';
  return 'var(--accent-green)';
}

function formatTPS(tps) { const n = parseFloat(tps); return isNaN(n) ? '20.0' : n.toFixed(1); }

function tpsColor(tps) {
  const n = parseFloat(tps);
  if (isNaN(n) || n >= 18) return 'var(--accent-cyan)';
  if (n >= 12) return 'var(--accent-yellow)';
  return 'var(--accent-red)';
}

// ─── CONSOLE ──────────────────────────────────────────────────────
function appendLog(entry, animate) {
  const wasAtBottom = isAtBottom(consoleOutput);
  const empty = consoleOutput.querySelector('.empty-state');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = `log-line type-${entry.type || 'info'}`;
  if (!animate) line.style.animation = 'none';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = shortTime(entry.timestamp);

  const prefix = document.createElement('span');
  prefix.className = 'log-prefix';
  prefix.textContent = TYPE_PREFIX[entry.type] || 'INFO';

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = entry.message || entry.raw || '';

  line.append(time, prefix, msg);
  consoleOutput.appendChild(line);
  while (consoleOutput.children.length > 500) consoleOutput.removeChild(consoleOutput.firstChild);
  updateLogCount();
  if (state.autoScroll && wasAtBottom) scrollConsoleToBottom();
}

// ─── ACTIVITY ─────────────────────────────────────────────────────
function appendActivity(entry, animate) {
  const empty = activityFeed.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = `activity-item type-${entry.type}`;
  if (!animate) item.style.animation = 'none';

  const icon = document.createElement('div');
  icon.className = 'activity-icon';
  icon.textContent = TYPE_ICON[entry.type] || '📋';

  const body = document.createElement('div');
  body.className = 'activity-body';

  const msgEl = document.createElement('div');
  msgEl.className = 'activity-msg';
  msgEl.textContent = entry.message || '';

  const timeEl = document.createElement('div');
  timeEl.className = 'activity-time';
  timeEl.textContent = relativeTime(entry.timestamp);

  body.append(msgEl, timeEl);
  item.append(icon, body);
  activityFeed.insertBefore(item, activityFeed.firstChild);
  while (activityFeed.children.length > 100) activityFeed.removeChild(activityFeed.lastChild);
}

// ─── PLAYER LIST ──────────────────────────────────────────────────
function updatePlayerList(players) {
  playerList.innerHTML = '';
  if (!players || players.length === 0) {
    playerList.innerHTML = '<div class="empty-state">No players online</div>';
    return;
  }
  players.forEach(name => {
    const item = document.createElement('div');
    item.className = 'player-item';
    item.addEventListener('click', () => openProfile(name));

    const avatar = document.createElement('div');
    avatar.className = 'player-avatar';
    const img = document.createElement('img');
    img.src = `https://minotar.net/avatar/${encodeURIComponent(name)}/28`;
    img.alt = name;
    img.onerror = () => { avatar.textContent = '🧑'; };
    avatar.appendChild(img);

    const nameEl = document.createElement('div');
    nameEl.className = 'player-name';
    nameEl.textContent = name;

    const dot = document.createElement('div');
    dot.className = 'player-dot';

    item.append(avatar, nameEl, dot);
    playerList.appendChild(item);
  });
}

// ─── PLAYER PROFILE ───────────────────────────────────────────────
const profileOverlay = $('profile-overlay');
const profileLoading = $('profile-loading');
const profileError   = $('profile-error');
const profileStats   = $('profile-stats');

function openProfile(username) {
  profileOverlay.classList.remove('hidden');
  profileLoading.classList.remove('hidden');
  profileError.hidden = true;
  profileStats.style.display = 'none';
  $('profile-name').textContent = username;
  $('profile-uuid').textContent = 'Loading…';
  $('profile-skin').innerHTML = '';

  const skinImg = document.createElement('img');
  skinImg.src = `https://minotar.net/armor/body/${encodeURIComponent(username)}/192`;
  skinImg.alt = username;
  skinImg.onerror = () => { $('profile-skin').innerHTML = '<span style="font-size:2.5rem">🧑</span>'; };
  skinImg.onload = () => { $('profile-skin').innerHTML = ''; $('profile-skin').appendChild(skinImg); };
  $('profile-skin').appendChild(skinImg);

  fetchPlayerStats(username);
}

function closeProfile() { profileOverlay.classList.add('hidden'); }

$('profile-close').addEventListener('click', closeProfile);
profileOverlay.addEventListener('click', e => { if (e.target === profileOverlay) closeProfile(); });

async function fetchPlayerStats(username) {
  try {
    const res = await fetch(`/api/player-stats/${encodeURIComponent(username)}`);
    const data = await res.json();

    if (!data.ok || !data.stats.found) {
      profileLoading.classList.add('hidden');
      profileError.textContent = 'Player data not found on server.';
      profileError.hidden = false;
      return;
    }

    const s = data.stats;
    $('profile-uuid').textContent = s.uuid || '—';

    setText('stat-health', s.health != null ? `${s.health} / 20` : '—');
    setText('stat-hunger', s.hunger != null ? `${s.hunger} / 20` : '—');
    setText('stat-playtime', formatPlayTime(s.timePlayed));
    setText('stat-deaths', s.deaths ?? '—');
    setText('stat-mobkills', s.mobKills ?? '—');
    setText('stat-playerkills', s.playerKills ?? '—');
    setText('stat-damagedealt', s.damageDealt ? Math.round(s.damageDealt).toLocaleString() : '—');
    setText('stat-damagetaken', s.damageTaken ? Math.round(s.damageTaken).toLocaleString() : '—');
    setText('stat-joins', s.joins ?? '—');
    setText('stat-level', s.level ?? '—');

    const healthEl = $('stat-health');
    if (s.health != null) healthEl.style.color = s.health > 14 ? 'var(--accent-green)' : s.health > 6 ? 'var(--accent-yellow)' : 'var(--accent-red)';

    profileLoading.classList.add('hidden');
    profileStats.style.display = 'flex';
  } catch {
    profileLoading.classList.add('hidden');
    profileError.textContent = 'Failed to load player stats.';
    profileError.hidden = false;
  }
}

function formatPlayTime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── TOASTS ───────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function showPlayerToast(entry) {
  const icons = { join: '✅', leave: '🚶', death: '💀', chat: '💬' };
  if (icons[entry.type]) showToast(`${icons[entry.type]} ${entry.message}`, entry.type);
}

// ─── CONNECTION STATUS ────────────────────────────────────────────
function setConnectionStatus(state_, label) {
  connectionBadge.className = `status-badge ${state_}`;
  statusLabel.textContent = label;
}

// ─── CLOCK ────────────────────────────────────────────────────────
function updateClock() { setText('server-time', new Date().toLocaleTimeString('en-GB', { hour12: false })); }
function updateUptime() {
  const ms = Date.now() - state.startTime;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  setText('val-uptime', h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`);
}

setInterval(updateClock, 1000);
setInterval(updateUptime, 1000);
updateClock();

// ─── HELPERS ──────────────────────────────────────────────────────
function setText(id, val) { const el = $(id); if (el && el.textContent !== String(val)) el.textContent = val; }
function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function shortTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''; }
function relativeTime(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
function isAtBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }
function scrollConsoleToBottom() { requestAnimationFrame(() => { consoleOutput.scrollTop = consoleOutput.scrollHeight; }); }
function updateLogCount() { setText('log-count', consoleOutput.querySelectorAll('.log-line').length); }

// ─── CONTROLS ─────────────────────────────────────────────────────
$('autoscroll-toggle').addEventListener('change', e => { state.autoScroll = e.target.checked; if (state.autoScroll) scrollConsoleToBottom(); });
$('btn-clear-console').addEventListener('click', () => { consoleOutput.innerHTML = '<div class="empty-state">Console cleared</div>'; updateLogCount(); });
$('btn-clear-activity').addEventListener('click', () => { activityFeed.innerHTML = '<div class="empty-state">Feed cleared</div>'; });

// ─── DISABLE KEYBOARD INPUT ───────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const allowed = ['c', 'a', 'f5', 'tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end', 'pageup', 'pagedown'];
  if (e.ctrlKey && allowed.includes(e.key.toLowerCase())) return;
  if (allowed.includes(e.key.toLowerCase())) return;
  if (e.key === 'F5' || e.key === 'F12') return;
  if (tag === 'INPUT' || tag === 'TEXTAREA') e.preventDefault();
});

// ─── PARTICLES ────────────────────────────────────────────────────
(function initParticles() {
  const canvas = $('particles-canvas');
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }

  function randomParticle() {
    return {
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3 - 0.1,
      r: Math.random() * 1.5 + 0.5, alpha: Math.random() * 0.5 + 0.1,
      color: ['#34d399','#3b82f6','#a855f7','#06b6d4'][Math.floor(Math.random() * 4)],
    };
  }

  function init() { resize(); particles = Array.from({ length: 80 }, randomParticle); }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.globalAlpha = p.alpha; ctx.fill();
      p.x += p.vx; p.y += p.vy;
      if (p.y < -5 || p.x < -5 || p.x > W + 5) Object.assign(p, randomParticle(), { y: H + 5, x: Math.random() * W });
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();

// ─── COPY IP ──────────────────────────────────────────────────────
$('server-ip').addEventListener('click', () => {
  navigator.clipboard.writeText('lifesteal.skilloraclouds.com').then(() => {
    showToast('📋 Server IP copied to clipboard!', 'join');
    const el = $('server-ip');
    el.style.color = 'var(--accent-blue)';
    setTimeout(() => el.style.color = 'var(--accent-green)', 1000);
  }).catch(() => showToast('❌ Failed to copy IP', 'error'));
});

// ─── BOOT ─────────────────────────────────────────────────────────
connect();
