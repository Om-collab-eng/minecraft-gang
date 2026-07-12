const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────
const PANEL_URL = process.env.PANEL_URL || 'https://panel.skilloraclouds.com';
const API_KEY   = process.env.API_KEY   || 'ptlc_LPQgGvrbQdE';
const SERVER_ID = process.env.SERVER_ID || '';
const PORT      = process.env.PORT      || 3000;

const SFTP_HOST = process.env.SFTP_HOST   || 'paid5.skilloraclouds.com';
const SFTP_PORT = parseInt(process.env.SFTP_PORT || '2022');
const SFTP_USER = process.env.SFTP_USER   || 'ayushmangupta00358e.9adcfa61';
const SFTP_KEY  = process.env.SFTP_PRIVATE_KEY || '';

// ─── STATE ───────────────────────────────────────────────────────
let serverInfo = {
  name: 'Minecrafter Gang SMP', status: 'connecting', version: 'Detecting...',
  motd: 'A Minecraft Server', players: [], playerCount: 0, maxPlayers: 20,
  tps: '20.0', uptime: Date.now(), memory: { used: 0, max: 0 },
  cpu: 0, diskUsed: 0, diskTotal: 0, panelStatus: 'offline',
};

const MAX_LOGS = 500, MAX_ACTIVITY = 100;
let consoleLogs = [], activityFeed = [];
let pteroWs = null, detectedServerId = SERVER_ID;

// ─── PTERODACTYL REST ────────────────────────────────────────────
function pteroRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(PANEL_URL + path);
    const options = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method,
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getServers() {
  try {
    const res = await pteroRequest('/api/client');
    if (res.status !== 200) return [];
    return res.body.data || [];
  } catch { return []; }
}

async function fetchResources(serverId) {
  try {
    const res = await pteroRequest(`/api/client/servers/${serverId}/resources`);
    if (res.status !== 200) return;
    const { current_state: state, resources: rs } = res.body.attributes;
    serverInfo.panelStatus = state;
    serverInfo.status = state === 'running' ? 'online' : state === 'starting' ? 'starting' : state === 'stopping' ? 'stopping' : 'offline';
    serverInfo.memory.used = Math.round(rs.memory_bytes / 1024 / 1024);
    serverInfo.cpu = rs.cpu_absolute ? rs.cpu_absolute.toFixed(1) : '0.0';
    serverInfo.diskUsed = Math.round(rs.disk_bytes / 1024 / 1024);
    broadcast({ type: 'serverInfo', data: serverInfo });
  } catch (e) { console.error('[Pterodactyl] Resource poll error:', e.message); }
}

// ─── PTERODACTYL WS CONSOLE ──────────────────────────────────────
async function connectConsole(serverId) {
  try {
    const res = await pteroRequest(`/api/client/servers/${serverId}/websocket`);
    if (res.status !== 200) { setTimeout(() => connectConsole(serverId), 10000); return; }
    const { token, socket } = res.body.data;
    pteroWs = new WebSocket(socket, { headers: { Origin: PANEL_URL } });
    pteroWs.on('open', () => { pteroWs.send(JSON.stringify({ event: 'auth', args: [token] })); });
    pteroWs.on('message', raw => { try { handlePteroEvent(JSON.parse(raw)); } catch {} });
    pteroWs.on('error', err => console.error('[Pterodactyl] WS error:', err.message));
    pteroWs.on('close', () => { pteroWs = null; setTimeout(() => connectConsole(serverId), 5000); });
  } catch (e) { setTimeout(() => connectConsole(serverId), 10000); }
}

function handlePteroEvent(msg) {
  const { event, args = [] } = msg;
  switch (event) {
    case 'auth success':
      if (pteroWs?.readyState === WebSocket.OPEN) {
        pteroWs.send(JSON.stringify({ event: 'send logs', args: [null] }));
        pteroWs.send(JSON.stringify({ event: 'send stats', args: [null] }));
      }
      break;
    case 'console output': if (args[0]) pushLog(args[0]); break;
    case 'status':
      serverInfo.panelStatus = args[0];
      serverInfo.status = args[0] === 'running' ? 'online' : args[0] === 'starting' ? 'starting' : args[0] === 'stopping' ? 'stopping' : 'offline';
      broadcast({ type: 'serverInfo', data: serverInfo });
      break;
    case 'stats':
      if (args[0]) {
        try {
          const rs = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
          serverInfo.memory.used = Math.round((rs.memory_bytes || 0) / 1024 / 1024);
          serverInfo.cpu = rs.cpu_absolute ? rs.cpu_absolute.toFixed(1) : '0.0';
          serverInfo.diskUsed = Math.round((rs.disk_bytes || 0) / 1024 / 1024);
          broadcast({ type: 'serverInfo', data: serverInfo });
        } catch {}
      }
      break;
    case 'token expiring':
    case 'token expired':
      refreshConsoleToken();
      break;
  }
}

async function refreshConsoleToken() {
  if (!detectedServerId || !pteroWs) return;
  try {
    const res = await pteroRequest(`/api/client/servers/${detectedServerId}/websocket`);
    if (res.status === 200 && pteroWs?.readyState === WebSocket.OPEN) {
      pteroWs.send(JSON.stringify({ event: 'auth', args: [res.body.data.token] }));
    }
  } catch {}
}

// ─── LOG PARSER ──────────────────────────────────────────────────
function classifyLine(line) {
  const s = line.replace(/\x1B\[[0-9;]*m/g, '').trim();
  if (!s) return null;

  let m = s.match(/: (.+) joined the game/);
  if (m) { const p = m[1].trim(); if (!serverInfo.players.includes(p)) { serverInfo.players.push(p); serverInfo.playerCount = serverInfo.players.length; } return { type: 'join', player: p, message: `${p} joined the game` }; }

  m = s.match(/: (.+) left the game/);
  if (m) { const p = m[1].trim(); serverInfo.players = serverInfo.players.filter(x => x !== p); serverInfo.playerCount = serverInfo.players.length; return { type: 'leave', player: p, message: `${p} left the game` }; }

  m = s.match(/INFO\]: (.+?) (was slain|died|fell|drowned|burned|suffocated|was killed|blew up|hit the ground|starved|experienced kinetic energy)/);
  if (m) return { type: 'death', player: m[1].trim(), message: s.split(']: ').slice(1).join(']: ').trim() };

  m = s.match(/INFO\]: <(.+?)> (.+)/);
  if (m) return { type: 'chat', player: m[1].trim(), message: `<${m[1].trim()}> ${m[2]}` };

  m = s.match(/Starting minecraft server version (.+)/i);
  if (m) { serverInfo.version = m[1].trim(); return { type: 'system', message: s }; }

  if (s.includes('Done (') && s.includes('! For help')) { serverInfo.status = 'online'; return { type: 'system', message: 'Server is ready! ✅' }; }

  if (/WARN/i.test(s)) return { type: 'warn', message: s.split(']: ').slice(1).join(']: ').trim() || s };
  if (/ERROR/i.test(s)) return { type: 'error', message: s.split(']: ').slice(1).join(']: ').trim() || s };

  return { type: 'info', message: s.split(']: ').slice(1).join(']: ').trim() || s };
}

function pushLog(raw) {
  const parsed = classifyLine(raw);
  if (!parsed) return;
  const entry = { ...parsed, raw, timestamp: new Date().toISOString(), id: Date.now() + Math.random() };
  consoleLogs.push(entry);
  if (consoleLogs.length > MAX_LOGS) consoleLogs.shift();
  if (['join', 'leave', 'death', 'chat'].includes(entry.type)) {
    activityFeed.push(entry);
    if (activityFeed.length > MAX_ACTIVITY) activityFeed.shift();
    broadcast({ type: 'activity', entry });
    broadcast({ type: 'serverInfo', data: serverInfo });
  }
  broadcast({ type: 'log', entry });
}

// ─── BROADCAST ───────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─── WS CLIENTS (no auth) ────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', serverInfo, consoleLogs, activityFeed }));
  ws.on('message', () => {});
});

// ─── DEBUG ───────────────────────────────────────────────────────
let debugLogs = [];
function logDebug(msg) { console.log(msg); debugLogs.push(`[${new Date().toISOString()}] ${msg}`); if (debugLogs.length > 50) debugLogs.shift(); }

// ─── STATIC + ROUTES ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => res.json({ ok: true, serverInfo }));

app.get('/api/debug', async (req, res) => {
  try {
    const testReq = await pteroRequest('/api/client');
    res.json({ ok: true, detectedServerId, serverInfo, debugLogs, consoleLogsCount: consoleLogs.length, testRequest: { status: testReq.status, bodyType: typeof testReq.body, bodyPreview: typeof testReq.body === 'string' ? testReq.body.slice(0, 1000) : testReq.body } });
  } catch (e) { res.json({ ok: false, error: e.message, debugLogs }); }
});

app.post('/api/error-report', (req, res) => { const { message, source, lineno, colno, error } = req.body; logDebug(`[Client Error] ${message} @ ${source}:${lineno}:${colno}`); res.json({ ok: true }); });

// ─── PLAYER STATS (public, no auth) ─────────────────────────────
app.get('/api/player-stats/:username', (req, res) => {
  res.json({ ok: true, stats: { username: req.params.username, found: false } });
});

// ─── IRON KIT CLAIM ──────────────────────────────────────────────
const CLAIMED_FILE = path.join(__dirname, 'claimed.json');
let claimedKits = {};

function loadClaimed() {
  try {
    if (fs.existsSync(CLAIMED_FILE)) {
      claimedKits = JSON.parse(fs.readFileSync(CLAIMED_FILE, 'utf8'));
    }
  } catch { claimedKits = {}; }
}

function saveClaimed() {
  try { fs.writeFileSync(CLAIMED_FILE, JSON.stringify(claimedKits, null, 2)); } catch {}
}

loadClaimed();

const KIT_ITEMS = [
  'iron_helmet 1',
  'iron_chestplate 1',
  'iron_leggings 1',
  'iron_boots 1',
  'iron_sword 1',
  'iron_pickaxe 1',
  'iron_axe 1',
  'cooked_beef 8',
];

function sendConsoleCommand(cmd) {
  if (pteroWs && pteroWs.readyState === WebSocket.OPEN) {
    pteroWs.send(JSON.stringify({ event: 'send command', args: [cmd] }));
  }
}

app.get('/api/claimed/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  const claimed = !!claimedKits[username];
  res.json({ ok: true, claimed, claimedAt: claimedKits[username]?.at || null });
});

app.post('/api/claim-kit', (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ ok: false, error: 'Username required.' });
  }

  const name = username.trim();
  const key = name.toLowerCase();

  if (!serverInfo.players.includes(name)) {
    return res.json({ ok: false, error: 'You must be online on the server to claim this kit.' });
  }

  if (claimedKits[key]) {
    return res.json({ ok: false, error: 'You have already claimed your free iron kit.' });
  }

  for (const item of KIT_ITEMS) {
    sendConsoleCommand(`give ${name} ${item}`);
  }

  claimedKits[key] = { at: new Date().toISOString() };
  saveClaimed();

  logDebug(`[Kit] Iron kit claimed by ${name}`);
  res.json({ ok: true, message: 'Iron kit delivered! Check your inventory.' });
});

// ─── SFTP TAILING ────────────────────────────────────────────────
let sftpConn = null, sftpLastSize = 0, sftpPollInterval = null;

function startSftpTailing() {
  if (sftpConn) return;
  sftpConn = new Client();

  sftpConn.on('ready', () => {
    serverInfo.status = 'online';
    broadcast({ type: 'serverInfo', data: serverInfo });
    sftpConn.sftp((err, sftp) => {
      if (err) { sftpConn.end(); return; }
      const logFile = 'logs/latest.log';
      function checkLog() {
        sftp.stat(logFile, (err, stats) => {
          if (err) return;
          if (sftpLastSize === 0) {
            const start = Math.max(0, stats.size - 12000);
            sftpReadChunk(sftp, logFile, start, stats.size);
            sftpLastSize = stats.size;
          } else if (stats.size > sftpLastSize) {
            sftpReadChunk(sftp, logFile, sftpLastSize, stats.size);
            sftpLastSize = stats.size;
          } else if (stats.size < sftpLastSize) {
            sftpLastSize = 0;
          }
        });
      }
      sftpPollInterval = setInterval(checkLog, 2500);
      checkLog();
    });
  });

  sftpConn.on('error', () => { cleanupSftp(); setTimeout(startSftpTailing, 8000); });
  sftpConn.on('close', () => { cleanupSftp(); setTimeout(startSftpTailing, 8000); });

  try {
    sftpConn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, privateKey: SFTP_KEY, readyTimeout: 15000 });
  } catch { cleanupSftp(); }
}

function cleanupSftp() { sftpConn = null; sftpLastSize = 0; if (sftpPollInterval) { clearInterval(sftpPollInterval); sftpPollInterval = null; } }

function sftpReadChunk(sftp, path, start, end) {
  const length = end - start;
  if (length <= 0) return;
  const buffer = Buffer.alloc(length);
  sftp.open(path, 'r', (err, fd) => {
    if (err) return;
    sftp.read(fd, buffer, 0, length, start, (err) => {
      sftp.close(fd, () => {});
      if (err) return;
      buffer.toString('utf8').split('\n').forEach(line => { if (line.trim()) pushLog(line); });
    });
  });
}

// ─── BOOT ────────────────────────────────────────────────────────
async function boot() {
  if (SFTP_KEY) {
    logDebug('Booting via SFTP...');
    startSftpTailing();
  } else {
    logDebug('Booting via Pterodactyl API...');
    const servers = await getServers();
    if (servers.length) {
      const first = servers[0].attributes;
      detectedServerId = first.identifier;
      serverInfo.name = first.name || 'Minecrafter Gang SMP';
      serverInfo.maxPlayers = first.limits?.threads || 20;
      connectConsole(detectedServerId);
      setInterval(() => fetchResources(detectedServerId), 8000);
      fetchResources(detectedServerId);
    }
  }

  server.listen(PORT, () => console.log(`[Dashboard] Running at http://localhost:${PORT}`));
}

boot();
