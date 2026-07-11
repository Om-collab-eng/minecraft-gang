/* ═══════════════════════════════════════════════════════════════
   MINECRAFTER GANG — FRONTEND APP
   WebSocket client + DOM logic — READ-ONLY, no commands allowed
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── STATE ───────────────────────────────────────────────────────
const state = {
  connected: false,
  autoScroll: true,
  startTime: Date.now(),
};

// ─── DOM REFS ─────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const consoleOutput  = $('console-output');
const activityFeed   = $('activity-feed');
const playerList     = $('player-list');
const connectionBadge = $('connection-badge');
const statusLabel    = connectionBadge.querySelector('.status-label');

// ─── TYPE → ICON MAP ─────────────────────────────────────────────
const TYPE_ICON = {
  join:   '✅',
  leave:  '🚶',
  death:  '💀',
  chat:   '💬',
  warn:   '⚠️',
  error:  '❌',
  system: '🔧',
  info:   '📋',
};

const TYPE_PREFIX = {
  join:   'JOIN',
  leave:  'LEAVE',
  death:  'DEATH',
  chat:   'CHAT',
  warn:   'WARN',
  error:  'ERROR',
  system: 'SYS',
  info:   'INFO',
};

// ─── WEBSOCKET ────────────────────────────────────────────────────
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}`);

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

  ws.addEventListener('error', () => {
    setConnectionStatus('disconnected', 'Error');
  });

  ws.addEventListener('message', evt => {
    try {
      const data = JSON.parse(evt.data);
      handleMessage(data);
    } catch (e) {
      console.warn('[Dashboard] Bad WS message:', e);
    }
  });

  // READ-ONLY — never send anything back to the server
  // (send is intentionally never called)
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'init':
      applyServerInfo(data.serverInfo);
      // Bulk-add preloaded logs (no animation for performance)
      data.consoleLogs.forEach(entry => appendLog(entry, false));
      data.activityFeed.forEach(entry => appendActivity(entry, false));
      updatePlayerList(data.serverInfo.players || []);
      scrollConsoleToBottom();
      break;

    case 'log':
      appendLog(data.entry, true);
      break;

    case 'activity':
      appendActivity(data.entry, true);
      showPlayerToast(data.entry);
      break;

    case 'serverInfo':
      applyServerInfo(data.data);
      break;
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

  if (info.memory?.used) {
    setText('val-mem-used', info.memory.used);
  }

  if (info.players) updatePlayerList(info.players);
}

function statusColor(s) {
  if (!s) return '';
  if (s.includes('stop')) return 'var(--accent-red)';
  if (s.includes('start') || s.includes('load')) return 'var(--accent-yellow)';
  return 'var(--accent-green)';
}

function formatTPS(tps) {
  const n = parseFloat(tps);
  if (isNaN(n)) return '20.0';
  return n.toFixed(1);
}

function tpsColor(tps) {
  const n = parseFloat(tps);
  if (isNaN(n) || n >= 18) return 'var(--accent-cyan)';
  if (n >= 12) return 'var(--accent-yellow)';
  return 'var(--accent-red)';
}

// ─── CONSOLE LINES ────────────────────────────────────────────────
function appendLog(entry, animate) {
  const wasAtBottom = isAtBottom(consoleOutput);

  // Remove empty state placeholder if present
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

  // Trim to 500 lines
  while (consoleOutput.children.length > 500) {
    consoleOutput.removeChild(consoleOutput.firstChild);
  }

  updateLogCount();

  if (state.autoScroll && wasAtBottom) scrollConsoleToBottom();
}

// ─── ACTIVITY FEED ────────────────────────────────────────────────
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

  // Newest at top
  activityFeed.insertBefore(item, activityFeed.firstChild);

  // Trim
  while (activityFeed.children.length > 100) {
    activityFeed.removeChild(activityFeed.lastChild);
  }
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

    const avatar = document.createElement('div');
    avatar.className = 'player-avatar';

    // Try to load Minecraft avatar from Minotar (fallback to emoji)
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

// ─── TOAST NOTIFICATIONS ──────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function showPlayerToast(entry) {
  const icons = { join: '✅', leave: '🚶', death: '💀', chat: '💬' };
  const icon = icons[entry.type];
  if (icon) showToast(`${icon} ${entry.message}`, entry.type);
}

// ─── CONNECTION STATUS ─────────────────────────────────────────────
function setConnectionStatus(state_, label) {
  connectionBadge.className = `status-badge ${state_}`;
  statusLabel.textContent = label;
}

// ─── CLOCK ────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  setText('server-time', now.toLocaleTimeString('en-GB', { hour12: false }));
}

function updateUptime() {
  const ms = Date.now() - state.startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  let str = h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  setText('val-uptime', str);
}

setInterval(updateClock, 1000);
setInterval(updateUptime, 1000);
updateClock();

// ─── HELPERS ──────────────────────────────────────────────────────
function setText(id, val) {
  const el = $(id);
  if (el && el.textContent !== String(val)) el.textContent = val;
}

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function shortTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollConsoleToBottom() {
  requestAnimationFrame(() => {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  });
}

function updateLogCount() {
  setText('log-count', consoleOutput.querySelectorAll('.log-line').length);
}

// ─── AUTO-SCROLL TOGGLE ───────────────────────────────────────────
$('autoscroll-toggle').addEventListener('change', e => {
  state.autoScroll = e.target.checked;
  if (state.autoScroll) scrollConsoleToBottom();
});

// ─── CLEAR BUTTONS ────────────────────────────────────────────────
$('btn-clear-console').addEventListener('click', () => {
  consoleOutput.innerHTML = '<div class="empty-state">Console cleared</div>';
  updateLogCount();
});

$('btn-clear-activity').addEventListener('click', () => {
  activityFeed.innerHTML = '<div class="empty-state">Feed cleared</div>';
});

// ─── DISABLE ALL KEYBOARD INPUT (EXTRA SAFETY) ────────────────────
// Prevent any accidental form submissions or keyboard shortcuts that
// could be misused — the dashboard is strictly read-only.
document.addEventListener('keydown', e => {
  // Allow: Ctrl+C (copy), Ctrl+A (select all), F5 (refresh), Tab, arrows
  const allowed = ['c', 'a', 'f5', 'tab', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end', 'pageup', 'pagedown'];
  if (e.ctrlKey && allowed.includes(e.key.toLowerCase())) return;
  if (allowed.includes(e.key.toLowerCase())) return;
  if (e.key === 'F5' || e.key === 'F12') return;
  // Block typing characters into any accidental text field
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    e.preventDefault();
  }
});

// ─── PARTICLE BACKGROUND ──────────────────────────────────────────
(function initParticles() {
  const canvas = $('particles-canvas');
  const ctx    = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function randomParticle() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3 - 0.1,
      r: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.5 + 0.1,
      color: ['#34d399','#3b82f6','#a855f7','#06b6d4'][Math.floor(Math.random()*4)],
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: 80 }, randomParticle);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -5 || p.x < -5 || p.x > W + 5) {
        Object.assign(p, randomParticle(), { y: H + 5, x: Math.random() * W });
      }
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  init();
  draw();
})();

// ─── BOOT ─────────────────────────────────────────────────────────
connect();
