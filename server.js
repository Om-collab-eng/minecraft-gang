const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Tail } = require('tail');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Update this path to point to your Minecraft server's latest.log
const MINECRAFT_LOG_PATH = process.env.MC_LOG_PATH || path.join(__dirname, 'logs', 'latest.log');
const PORT = process.env.PORT || 3000;

// ─── STATE ───────────────────────────────────────────────────────────────────
let serverInfo = {
  name: 'Minecrafter Gang SMP',
  status: 'online',
  version: 'Detecting...',
  motd: 'A Minecraft Server',
  players: [],
  playerCount: 0,
  maxPlayers: 20,
  tps: '20.0',
  uptime: Date.now(),
  memory: { used: 0, max: 0 },
  world: 'world',
};

// Ring buffers
const MAX_LOG_LINES = 500;
const MAX_ACTIVITY = 100;
let consoleLogs = [];
let activityFeed = [];

// ─── LOG PARSER ──────────────────────────────────────────────────────────────
function classifyLine(line) {
  const stripped = line.replace(/\x1B\[[0-9;]*m/g, '');

  // Player join
  let m = stripped.match(/\[.*?\].*?: (.+) joined the game/);
  if (m) {
    const player = m[1].trim();
    if (!serverInfo.players.includes(player)) {
      serverInfo.players.push(player);
      serverInfo.playerCount = serverInfo.players.length;
    }
    return { type: 'join', player, message: `${player} joined the game` };
  }

  // Player leave
  m = stripped.match(/\[.*?\].*?: (.+) left the game/);
  if (m) {
    const player = m[1].trim();
    serverInfo.players = serverInfo.players.filter(p => p !== player);
    serverInfo.playerCount = serverInfo.players.length;
    return { type: 'leave', player, message: `${player} left the game` };
  }

  // Player death
  m = stripped.match(/\[.*?\] \[Server thread\/INFO\]: (.+) (died|was slain|fell|drowned|burned|suffocated|was killed|blew up|hit the ground|experienced kinetic energy|starved|walked into)/);
  if (m) {
    return { type: 'death', player: m[1].trim(), message: stripped.split(']: ').slice(1).join(']: ').trim() };
  }

  // Player chat
  m = stripped.match(/\[.*?\] \[Server thread\/INFO\]: <(.+?)> (.+)/);
  if (m) {
    return { type: 'chat', player: m[1].trim(), message: `<${m[1].trim()}> ${m[2]}` };
  }

  // Server started / version
  m = stripped.match(/Starting minecraft server version (.+)/i);
  if (m) {
    serverInfo.version = m[1].trim();
    return { type: 'system', message: stripped.split(']: ').slice(1).join(']: ').trim() };
  }

  // Done loading
  if (stripped.includes('Done (') && stripped.includes('! For help')) {
    serverInfo.status = 'online';
    return { type: 'system', message: 'Server is ready!' };
  }

  // Stopping
  if (stripped.includes('Stopping server') || stripped.includes('Stopping the server')) {
    serverInfo.status = 'stopping';
    return { type: 'warn', message: 'Server is stopping...' };
  }

  // TPS / Memory (Paper/Spigot)
  m = stripped.match(/TPS from last 1m, 5m, 15m: ([\d.]+), ([\d.]+), ([\d.]+)/);
  if (m) {
    serverInfo.tps = m[1];
    return { type: 'info', message: stripped.split(']: ').slice(1).join(']: ').trim() };
  }

  // WARN
  if (stripped.match(/\[.*?WARN.*?\]/i)) {
    return { type: 'warn', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped };
  }

  // ERROR
  if (stripped.match(/\[.*?ERROR.*?\]/i)) {
    return { type: 'error', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped };
  }

  return { type: 'info', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped };
}

function pushLog(raw) {
  const parsed = classifyLine(raw);
  const entry = {
    ...parsed,
    raw,
    timestamp: new Date().toISOString(),
    id: Date.now() + Math.random(),
  };

  consoleLogs.push(entry);
  if (consoleLogs.length > MAX_LOG_LINES) consoleLogs.shift();

  // Activity feed only for player events
  if (['join', 'leave', 'death', 'chat'].includes(entry.type)) {
    activityFeed.push(entry);
    if (activityFeed.length > MAX_ACTIVITY) activityFeed.shift();
  }

  broadcast({ type: 'log', entry });

  if (['join', 'leave', 'death', 'chat'].includes(entry.type)) {
    broadcast({ type: 'activity', entry });
    broadcast({ type: 'serverInfo', data: serverInfo });
  }
}

// ─── BROADCAST ───────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ─── LOG TAILING ─────────────────────────────────────────────────────────────
let tail;

function startTailing() {
  // Create logs dir + dummy file if not present (for demo/dev)
  const logsDir = path.dirname(MINECRAFT_LOG_PATH);
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  if (!fs.existsSync(MINECRAFT_LOG_PATH)) {
    fs.writeFileSync(MINECRAFT_LOG_PATH, '');
    console.log(`[Dashboard] Created empty log file at ${MINECRAFT_LOG_PATH}`);
  }

  try {
    tail = new Tail(MINECRAFT_LOG_PATH, { useWatchFile: true, flushAtEOF: true });
    tail.on('line', line => { if (line.trim()) pushLog(line); });
    tail.on('error', err => console.error('[Tail error]', err));
    console.log(`[Dashboard] Tailing: ${MINECRAFT_LOG_PATH}`);
  } catch (e) {
    console.error('[Dashboard] Could not tail log file:', e.message);
  }
}

// Load last N lines of existing log on startup
function preloadLog() {
  if (!fs.existsSync(MINECRAFT_LOG_PATH)) return;
  const lines = fs.readFileSync(MINECRAFT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  const recent = lines.slice(-MAX_LOG_LINES);
  recent.forEach(line => {
    const parsed = classifyLine(line);
    consoleLogs.push({ ...parsed, raw: line, timestamp: new Date().toISOString(), id: Date.now() + Math.random() });
  });
}

// ─── MEMORY MONITOR ──────────────────────────────────────────────────────────
setInterval(() => {
  const total = os.totalmem();
  const free = os.freemem();
  serverInfo.memory = {
    used: Math.round((total - free) / 1024 / 1024),
    max: Math.round(total / 1024 / 1024),
  };
  broadcast({ type: 'serverInfo', data: serverInfo });
}, 5000);

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('[Dashboard] Client connected');

  // Send initial state
  ws.send(JSON.stringify({ type: 'init', serverInfo, consoleLogs, activityFeed }));

  // READ-ONLY: ignore any incoming messages from clients
  ws.on('message', () => {
    // Silently drop — no commands allowed
  });

  ws.on('close', () => console.log('[Dashboard] Client disconnected'));
});

// ─── STATIC FILES ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/status', (req, res) => {
  res.json({ ok: true, serverInfo });
});

// ─── START ───────────────────────────────────────────────────────────────────
preloadLog();
startTailing();

server.listen(PORT, () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard] Watching log: ${MINECRAFT_LOG_PATH}`);
  console.log(`[Dashboard] Set MC_LOG_PATH env var to point to your server's logs/latest.log`);
});
