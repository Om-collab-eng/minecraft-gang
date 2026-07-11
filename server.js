const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const path = require('path');
const { Client } = require('ssh2');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
const url = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PANEL_URL    = process.env.PANEL_URL    || 'https://panel.skilloraclouds.com';
const API_KEY      = process.env.API_KEY      || 'ptlc_LPQgGvrbQdE';
const SERVER_ID    = process.env.SERVER_ID    || ''; // Will be auto-detected
const PORT         = process.env.PORT         || 3000;

// SFTP Config (for bypassing Cloudflare on panel API)
const SFTP_HOST   = process.env.SFTP_HOST   || 'paid5.skilloraclouds.com';
const SFTP_PORT   = parseInt(process.env.SFTP_PORT || '2022');
const SFTP_USER   = process.env.SFTP_USER   || 'ayushmangupta00358e.9adcfa61';
const SFTP_KEY    = process.env.SFTP_PRIVATE_KEY || ''; // PEM private key string


// ─── STATE ───────────────────────────────────────────────────────────────────
let serverInfo = {
  name: 'Minecrafter Gang SMP',
  status: 'connecting',
  version: 'Detecting...',
  motd: 'A Minecraft Server',
  players: [],
  playerCount: 0,
  maxPlayers: 20,
  tps: '20.0',
  uptime: Date.now(),
  memory: { used: 0, max: 0 },
  cpu: 0,
  diskUsed: 0,
  diskTotal: 0,
  panelStatus: 'offline',
};

const MAX_LOGS = 500;
const MAX_ACTIVITY = 100;
let consoleLogs = [];
let activityFeed = [];

let pteroWs = null;
let detectedServerId = SERVER_ID;

// ─── PTERODACTYL REST HELPER ──────────────────────────────────────────────────
function pteroRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(PANEL_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'MinecrafterGangDashboard/1.0',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── GET SERVER LIST ──────────────────────────────────────────────────────────
async function getServers() {
  try {
    const res = await pteroRequest('/api/client');
    if (res.status !== 200) {
      logDebug(`[Pterodactyl] Failed to get servers: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      return [];
    }
    return res.body.data || [];
  } catch (e) {
    logDebug(`[Pterodactyl] Error fetching servers: ${e.message}`);
    return [];
  }
}

// ─── GET RESOURCE USAGE ───────────────────────────────────────────────────────
async function fetchResources(serverId) {
  try {
    const res = await pteroRequest(`/api/client/servers/${serverId}/resources`);
    if (res.status !== 200) return;
    const attrs = res.body.attributes;
    const state = attrs.current_state;
    const rs    = attrs.resources;

    serverInfo.panelStatus = state;
    serverInfo.status = state === 'running' ? 'online'
                      : state === 'starting' ? 'starting'
                      : state === 'stopping' ? 'stopping'
                      : 'offline';

    serverInfo.memory.used = Math.round(rs.memory_bytes / 1024 / 1024);
    serverInfo.cpu         = rs.cpu_absolute ? rs.cpu_absolute.toFixed(1) : '0.0';
    serverInfo.diskUsed    = Math.round(rs.disk_bytes / 1024 / 1024);

    broadcast({ type: 'serverInfo', data: serverInfo });
  } catch (e) {
    console.error('[Pterodactyl] Resource poll error:', e.message);
  }
}

// ─── PTERODACTYL WEBSOCKET CONSOLE ───────────────────────────────────────────
async function connectConsole(serverId) {
  try {
    const res = await pteroRequest(`/api/client/servers/${serverId}/websocket`);
    if (res.status !== 200) {
      logDebug(`[Pterodactyl] Cannot get WS credentials: ${res.status}`);
      setTimeout(() => connectConsole(serverId), 10000);
      return;
    }

    const { token, socket } = res.body.data;
    logDebug('[Pterodactyl] Connecting to console WebSocket...');

    pteroWs = new WebSocket(socket, {
      headers: { Origin: PANEL_URL },
    });

    pteroWs.on('open', () => {
      logDebug('[Pterodactyl] Console WS connected');
      // Authenticate with the panel
      pteroWs.send(JSON.stringify({ event: 'auth', args: [token] }));
    });

    pteroWs.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        handlePteroEvent(msg);
      } catch (e) { /* ignore */ }
    });

    pteroWs.on('error', err => {
      console.error('[Pterodactyl] Console WS error:', err.message);
    });

    pteroWs.on('close', () => {
      console.log('[Pterodactyl] Console WS closed — reconnecting in 5s...');
      pteroWs = null;
      setTimeout(() => connectConsole(serverId), 5000);
    });

  } catch (e) {
    console.error('[Pterodactyl] connectConsole error:', e.message);
    setTimeout(() => connectConsole(serverId), 10000);
  }
}

// ─── HANDLE PTERODACTYL EVENTS ────────────────────────────────────────────────
function handlePteroEvent(msg) {
  const event = msg.event;
  const args  = msg.args || [];

  switch (event) {
    case 'auth success':
      console.log('[Pterodactyl] Authenticated to console ✅');
      // Request server logs history
      if (pteroWs && pteroWs.readyState === WebSocket.OPEN) {
        pteroWs.send(JSON.stringify({ event: 'send logs', args: [null] }));
        pteroWs.send(JSON.stringify({ event: 'send stats', args: [null] }));
      }
      break;

    case 'console output':
      if (args[0]) pushLog(args[0]);
      break;

    case 'status':
      serverInfo.panelStatus = args[0];
      serverInfo.status = args[0] === 'running' ? 'online'
                        : args[0] === 'starting' ? 'starting'
                        : args[0] === 'stopping' ? 'stopping'
                        : 'offline';
      broadcast({ type: 'serverInfo', data: serverInfo });
      break;

    case 'stats':
      if (args[0]) {
        try {
          const stats = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
          serverInfo.memory.used = Math.round((stats.memory_bytes || 0) / 1024 / 1024);
          serverInfo.cpu         = stats.cpu_absolute ? stats.cpu_absolute.toFixed(1) : '0.0';
          serverInfo.diskUsed    = Math.round((stats.disk_bytes || 0) / 1024 / 1024);
          if (stats.uptime) serverInfo.serverUptime = stats.uptime;
          broadcast({ type: 'serverInfo', data: serverInfo });
        } catch (e) { /* ignore */ }
      }
      break;

    case 'token expiring':
    case 'token expired':
      console.log('[Pterodactyl] Token expiring — refreshing...');
      refreshConsoleToken();
      break;

    default:
      break;
  }
}

// ─── REFRESH WS TOKEN ─────────────────────────────────────────────────────────
async function refreshConsoleToken() {
  if (!detectedServerId || !pteroWs) return;
  try {
    const res = await pteroRequest(`/api/client/servers/${detectedServerId}/websocket`);
    if (res.status === 200 && pteroWs && pteroWs.readyState === WebSocket.OPEN) {
      const { token } = res.body.data;
      pteroWs.send(JSON.stringify({ event: 'auth', args: [token] }));
    }
  } catch (e) {
    console.error('[Pterodactyl] Token refresh error:', e.message);
  }
}

// ─── LOG PARSER ──────────────────────────────────────────────────────────────
function classifyLine(line) {
  const stripped = line.replace(/\x1B\[[0-9;]*m/g, '').trim();
  if (!stripped) return null;

  // Player join
  let m = stripped.match(/: (.+) joined the game/);
  if (m) {
    const player = m[1].trim();
    if (!serverInfo.players.includes(player)) {
      serverInfo.players.push(player);
      serverInfo.playerCount = serverInfo.players.length;
    }
    return { type: 'join', player, message: `${player} joined the game` };
  }

  // Player leave
  m = stripped.match(/: (.+) left the game/);
  if (m) {
    const player = m[1].trim();
    serverInfo.players = serverInfo.players.filter(p => p !== player);
    serverInfo.playerCount = serverInfo.players.length;
    return { type: 'leave', player, message: `${player} left the game` };
  }

  // Player death keywords
  m = stripped.match(/INFO\]: (.+?) (was slain|died|fell|drowned|burned|suffocated|was killed|blew up|hit the ground|starved|experienced kinetic energy)/);
  if (m) return { type: 'death', player: m[1].trim(), message: stripped.split(']: ').slice(1).join(']: ').trim() };

  // Chat
  m = stripped.match(/INFO\]: <(.+?)> (.+)/);
  if (m) return { type: 'chat', player: m[1].trim(), message: `<${m[1].trim()}> ${m[2]}` };

  // Version
  m = stripped.match(/Starting minecraft server version (.+)/i);
  if (m) { serverInfo.version = m[1].trim(); return { type: 'system', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped }; }

  // Done loading
  if (stripped.includes('Done (') && stripped.includes('! For help')) {
    serverInfo.status = 'online';
    return { type: 'system', message: 'Server is ready! ✅' };
  }

  // WARN
  if (/WARN/i.test(stripped)) return { type: 'warn', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped };

  // ERROR
  if (/ERROR/i.test(stripped)) return { type: 'error', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped };

  return { type: 'info', message: stripped.split(']: ').slice(1).join(']: ').trim() || stripped };
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

// ─── BROADCAST ───────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── WS CLIENTS ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const parameters = url.parse(req.url, true).query;
  const token = parameters.token;
  const username = verifySession(token);

  if (!username) {
    logDebug(`[Dashboard] Unauthorized WS connection attempt rejected. IP: ${req.socket.remoteAddress}`);
    ws.close(4001, 'Unauthorized');
    return;
  }

  logDebug(`[Dashboard] Browser client connected for player: ${username}`);
  ws.send(JSON.stringify({ type: 'init', serverInfo, consoleLogs, activityFeed }));
  ws.on('message', () => { /* READ-ONLY — drop all messages */ });
  ws.on('close', () => logDebug(`[Dashboard] Browser client disconnected for player: ${username}`));
});

// ─── DEBUG / DIAGNOSTICS ──────────────────────────────────────────────────────
let debugLogs = [];
function logDebug(msg) {
  console.log(msg);
  debugLogs.push(`[${new Date().toISOString()}] ${msg}`);
  if (debugLogs.length > 50) debugLogs.shift();
}

// ─── STATIC ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/status', (req, res) => res.json({ ok: true, serverInfo }));
app.get('/api/debug', async (req, res) => {
  try {
    const testReq = await pteroRequest('/api/client');
    res.json({
      ok: true,
      detectedServerId,
      serverInfo,
      debugLogs,
      consoleLogsCount: consoleLogs.length,
      consoleLogsPreview: consoleLogs.slice(-5),
      testRequest: {
        status: testReq.status,
        headers: testReq.headers,
        bodyType: typeof testReq.body,
        bodyPreview: typeof testReq.body === 'string' ? testReq.body.slice(0, 1000) : testReq.body
      }
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, debugLogs, consoleLogsCount: consoleLogs.length });
  }
});

app.post('/api/error-report', (req, res) => {
  const { message, source, lineno, colno, error } = req.body;
  logDebug(`[Client Error] Msg: ${message} | Src: ${source}:${lineno}:${colno} | Stack: ${error}`);
  res.json({ ok: true });
});

// ─── AUTH / DATABASE HELPERS ──────────────────────────────────────────────────
const DB_LOCAL_PATH = '/tmp/authme.db';
let dbSyncTime = 0;
const activeSessions = new Map(); // token -> username

// Synchronize AuthMe DB from remote SFTP server
function syncAuthDb() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (fs.existsSync(DB_LOCAL_PATH) && (now - dbSyncTime < 120000)) {
      return resolve(DB_LOCAL_PATH);
    }

    // Method 1: Try SFTP
    if (sftpConn) {
      sftpConn.sftp((err, sftp) => {
        if (err) {
          logDebug(`[Auth] SFTP session failed, trying Pterodactyl API: ${err.message}`);
          return downloadAuthDbViaApi().then(resolve).catch(reject);
        }
        logDebug('[Auth] Downloading authme.db via SFTP...');
        sftp.fastGet('plugins/AuthMe/authme.db', DB_LOCAL_PATH, {}, (err) => {
          if (err) {
            logDebug(`[Auth] SFTP fastGet failed: ${err.message}, trying Pterodactyl API...`);
            return downloadAuthDbViaApi().then(resolve).catch(reject);
          }
          dbSyncTime = Date.now();
          logDebug('[Auth] authme.db synced via SFTP');
          resolve(DB_LOCAL_PATH);
        });
      });
    } else {
      // Method 2: Download via Pterodactyl file download API
      downloadAuthDbViaApi().then(resolve).catch(reject);
    }
  });
}

// Fallback: download authme.db via Pterodactyl client API
function downloadAuthDbViaApi() {
  return new Promise(async (resolve, reject) => {
    if (!detectedServerId) {
      return reject(new Error('No server ID detected — cannot download auth database'));
    }
    logDebug('[Auth] Downloading authme.db via Pterodactyl file API...');
    try {
      const res = await pteroRequest(`/api/client/servers/${detectedServerId}/files/download?file=${encodeURIComponent('plugins/AuthMe/authme.db')}`);
      if (res.status !== 200) {
        return reject(new Error(`Pterodactyl file download failed: ${res.status}`));
      }
      // The response body contains a redirect URL with a token
      const downloadUrl = res.body.attributes?.url;
      if (!downloadUrl) {
        return reject(new Error('No download URL from Pterodactyl'));
      }
      // Follow redirect to download the actual file
      https.get(downloadUrl, (dlRes) => {
        if (dlRes.statusCode >= 300 && dlRes.statusCode < 400 && dlRes.headers.location) {
          https.get(dlRes.headers.location, (dlRes2) => {
            const chunks = [];
            dlRes2.on('data', c => chunks.push(c));
            dlRes2.on('end', () => {
              fs.writeFileSync(DB_LOCAL_PATH, Buffer.concat(chunks));
              dbSyncTime = Date.now();
              logDebug('[Auth] authme.db synced via Pterodactyl API');
              resolve(DB_LOCAL_PATH);
            });
          }).on('error', e => reject(new Error(`Download redirect failed: ${e.message}`)));
        } else {
          const chunks = [];
          dlRes.on('data', c => chunks.push(c));
          dlRes.on('end', () => {
            fs.writeFileSync(DB_LOCAL_PATH, Buffer.concat(chunks));
            dbSyncTime = Date.now();
            logDebug('[Auth] authme.db synced via Pterodactyl API');
            resolve(DB_LOCAL_PATH);
          });
        }
      }).on('error', e => reject(new Error(`Download failed: ${e.message}`)));
    } catch (e) {
      reject(new Error(`Pterodactyl API download error: ${e.message}`));
    }
  });
}

// Detect the actual AuthMe table name
async function getAuthTableName(dbPath) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve('authme');
    });
    db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
      db.close();
      if (err || !rows) return resolve('authme');
      const names = rows.map(r => r.name);
      // Common AuthMe table names
      const match = names.find(n => /^authme(-users)?$/i.test(n)) || names[0] || 'authme';
      logDebug(`[Auth] Detected table name: "${match}" (all tables: ${names.join(', ')})`);
      resolve(match);
    });
  });
}

// Detect column names in the auth table
async function getAuthColumns(dbPath, tableName) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve(null);
    });
    db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
      db.close();
      if (err || !rows) return resolve(null);
      const cols = rows.map(r => r.name);
      logDebug(`[Auth] Columns in "${tableName}": ${cols.join(', ')}`);
      resolve(cols);
    });
  });
}

// Verify password against AuthMe hash format
function verifyAuthMePassword(hash, password) {
  if (!hash) return false;

  // $SHA$salt$hash — double SHA-256 with salt
  if (hash.startsWith('$SHA$')) {
    const parts = hash.split('$');
    if (parts.length < 4) return false;
    const salt = parts[2];
    const storedHash = parts[3];
    const hash1 = crypto.createHash('sha256').update(password).digest('hex');
    const hash2 = crypto.createHash('sha256').update(hash1 + salt).digest('hex');
    return hash2 === storedHash;
  }

  // $SHA256$salt$hash — single SHA-256 with salt
  if (hash.startsWith('$SHA256$')) {
    const parts = hash.split('$');
    if (parts.length < 4) return false;
    const salt = parts[2];
    const storedHash = parts[3];
    const computed = crypto.createHash('sha256').update(salt + password).digest('hex');
    return computed === storedHash;
  }

  // $2a$... or $2b$... — bcrypt
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
    try {
      const bcrypt = require('bcryptjs');
      return bcrypt.compareSync(password, hash);
    } catch {
      // bcryptjs not available
      logDebug('[Auth] bcrypt hash detected but bcryptjs not installed');
      return false;
    }
  }

  // $argon2... — argon2
  if (hash.startsWith('$argon2')) {
    try {
      const argon2 = require('argon2');
      return argon2.verify(hash, password);
    } catch {
      logDebug('[Auth] argon2 hash detected but argon2 not installed');
      return false;
    }
  }

  // $5$salt$hash — SHA-256 crypt
  if (hash.startsWith('$5$')) {
    const parts = hash.split('$');
    if (parts.length < 3) return false;
    const salt = parts[1];
    const storedHash = parts[2];
    const computed = crypto.createHash('sha256').update(salt + password).digest('hex');
    return computed === storedHash;
  }

  // $6$salt$hash — SHA-512 crypt
  if (hash.startsWith('$6$')) {
    const parts = hash.split('$');
    if (parts.length < 3) return false;
    const salt = parts[1];
    const storedHash = parts[2];
    const computed = crypto.createHash('sha512').update(salt + password).digest('hex');
    return computed === storedHash;
  }

  // Plaintext fallback (insecure but some servers have it)
  logDebug(`[Auth] Unknown hash format: ${hash.substring(0, 20)}... — trying plaintext comparison`);
  return hash === password;
}

// Detect password column name
function getPasswordCol(columns) {
  if (!columns) return 'password';
  const candidates = ['password', 'pass', 'pwd', 'hash', 'passwordhash'];
  return columns.find(c => candidates.includes(c.toLowerCase())) || columns.find(c => c.toLowerCase().includes('pass')) || 'password';
}

// Detect realname column name
function getRealnameCol(columns) {
  if (!columns) return 'realname';
  const candidates = ['realname', 'real_name', 'realnamecolumn', 'displayname'];
  return columns.find(c => candidates.includes(c.toLowerCase())) || columns.find(c => c.toLowerCase().includes('real')) || 'realname';
}

// Detect username column name
function getUsernameCol(columns) {
  if (!columns) return 'username';
  const candidates = ['username', 'user', 'player_name', 'playername', 'name'];
  return columns.find(c => candidates.includes(c.toLowerCase())) || columns.find(c => c.toLowerCase().includes('user') || c.toLowerCase().includes('name')) || 'username';
}

// Verify credentials from SQLite
function authenticatePlayer(username, password) {
  return new Promise(async (resolve, reject) => {
    try {
      await syncAuthDb();
      
      const tableName = await getAuthTableName(DB_LOCAL_PATH);
      const columns = await getAuthColumns(DB_LOCAL_PATH, tableName);
      const passCol = getPasswordCol(columns);
      const realCol = getRealnameCol(columns);
      const userCol = getUsernameCol(columns);

      logDebug(`[Auth] Querying: SELECT ${passCol}, ${realCol} FROM ${tableName} WHERE ${userCol} = ?`);

      const db = new sqlite3.Database(DB_LOCAL_PATH, sqlite3.OPEN_READONLY, (err) => {
        if (err) return reject(new Error(`SQLite open error: ${err.message}`));
      });

      db.get(`SELECT ${passCol} AS password, ${realCol} AS realname FROM ${tableName} WHERE ${userCol} = ?`, [username.toLowerCase()], (err, row) => {
        db.close();
        if (err) return reject(new Error(`Database query error: ${err.message}`));
        if (!row) {
          logDebug(`[Auth] User "${username}" not found in ${tableName}`);
          return resolve(null);
        }

        logDebug(`[Auth] Found user "${row.realname}", hash starts with: ${row.password?.substring(0, 15)}...`);
        const isValid = verifyAuthMePassword(row.password, password);
        logDebug(`[Auth] Password verification: ${isValid ? 'SUCCESS' : 'FAILED'}`);
        if (isValid) {
          resolve({ username: row.realname || username });
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      logDebug(`[Auth] Error: ${e.message}`);
      reject(e);
    }
  });
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, username);
  return token;
}

function verifySession(token) {
  if (!token) return null;
  return activeSessions.get(token) || null;
}

// ─── LOGIN ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Missing username or password' });
  }

  try {
    const user = await authenticatePlayer(username, password);
    if (user) {
      const token = createSession(user.username);
      logDebug(`[Login] SUCCESS: ${user.username} logged in`);
      res.json({ ok: true, token, username: user.username });
    } else {
      logDebug(`[Login] FAILED: "${username}" — bad credentials or user not found`);
      res.status(401).json({ ok: false, error: 'Invalid username or password. Make sure you use your Minecraft username and AuthMe password.' });
    }
  } catch (err) {
    logDebug(`[Login Error] ${err.message}`);
    // Give a more specific error message
    let hint = '';
    if (err.message.includes('SFTP')) {
      hint = ' (SFTP not connected — set SFTP_PRIVATE_KEY)';
    } else if (err.message.includes('Pterodactyl')) {
      hint = ' (Could not reach Pterodactyl panel)';
    }
    res.status(500).json({ ok: false, error: `Authentication database error${hint}` });
  }
});

app.post('/api/verify-session', (req, res) => {
  const { token } = req.body;
  const username = verifySession(token);
  if (username) {
    res.json({ ok: true, username });
  } else {
    res.status(401).json({ ok: false, error: 'Invalid session' });
  }
});

// ─── PLAYER STATS (via SFTP) ─────────────────────────────────────────────────
function sftpReadFile(remotePath) {
  return new Promise((resolve, reject) => {
    if (!sftpConn) return reject(new Error('SFTP not connected'));
    sftpConn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(remotePath, 'utf8', (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
  });
}

async function getPlayerUUID(username) {
  try {
    const https = require('https');
    return await new Promise((resolve, reject) => {
      https.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j && j.id) resolve(j.id);
            else resolve(null);
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  } catch { return null; }
}

function parseSimpleYml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function parseVanillaStats(text) {
  try {
    const json = JSON.parse(text);
    const stats = json.stats || json;
    // Could be under "minecraft:custom" or "minecraft:player"
    const custom = stats['minecraft:custom'] || {};
    const player = stats['minecraft:player'] || {};
    const mined = stats['minecraft:mined'] || {};
    const killed = stats['minecraft:killed'] || {};
    const crafted = stats['minecraft:crafted'] || {};
    return { custom, player, mined, killed, crafted };
  } catch { return null; }
}

app.get('/api/player-stats/:username', async (req, res) => {
  const { username } = req.params;
  const token = req.query.token || req.headers['x-auth-token'];
  if (!verifySession(token)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!sftpConn) {
    return res.status(503).json({ ok: false, error: 'SFTP not connected' });
  }

  try {
    // Get UUID from Mojang
    const uuid = await getPlayerUUID(username);
    if (!uuid) {
      return res.json({ ok: true, stats: { username, found: false } });
    }

    // Format UUID with dashes for file paths
    const uuidDashed = uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    const uuidRaw = uuid; // no dashes

    const stats = { username, uuid, found: true };

    // Try EssentialsX userdata (health, hunger, level, first/last login)
    try {
      const essData = await sftpReadFile(`plugins/Essentials/userdata/${uuidRaw}.yml`);
      const yml = parseSimpleYml(essData);
      stats.health = parseInt(yml.health) || 20;
      stats.hunger = parseInt(yml.food) || 20;
      stats.level = parseInt(yml.level) || 0;
      stats.firstLogin = yml['first-login'] || null;
      stats.lastLogin = yml['last-login'] || null;
      stats.lastLoginIP = yml['last-login-address'] || null;
      // Essentials stores playtime in seconds as 'time-played'
      const tp = parseInt(yml['time-played']) || 0;
      stats.timePlayed = tp;
    } catch {
      stats.health = null;
    }

    // Try vanilla stats JSON (deaths, kills, play_time)
    try {
      const vanillaPath = `world/stats/${uuidDashed}.json`;
      const vanillaData = await sftpReadFile(vanillaPath);
      const parsed = parseVanillaStats(vanillaData);
      if (parsed) {
        stats.deaths = parsed.custom['minecraft:deaths'] || 0;
        stats.mobKills = parsed.custom['minecraft:mob_kills'] || 0;
        stats.playerKills = parsed.custom['minecraft:player_kills'] || 0;
        stats.damageDealt = parsed.custom['minecraft:damage_dealt'] || 0;
        stats.damageTaken = parsed.custom['minecraft:damage_taken'] || 0;
        stats.playTimeTicks = parsed.custom['minecraft:play_time'] || 0;
        // 20 ticks = 1 second
        if (!stats.timePlayed && stats.playTimeTicks) {
          stats.timePlayed = Math.floor(stats.playTimeTicks / 20);
        }
        stats.joins = parsed.custom['minecraft:leave_game'] || 0;
        stats.walked = parsed.custom['minecraft:walked_one_cm'] || 0;
        stats.jumped = parsed.custom['minecraft:jump'] || 0;
      }
    } catch {
      // Vanilla stats file may not exist
    }

    // Try player .dat for exact health (NBT binary, parse basic fields)
    try {
      const datPath = `world/playerdata/${uuidDashed}.dat`;
      const datBuf = await sftpReadFileRaw(datPath);
      if (datBuf && stats.health === null) {
        // Basic NBT scan for health attribute (TAG_Double named "generic.max_health" / "Health")
        // We'll just try to find the float value after 'Health' tag name
        const str = datBuf.toString('latin1');
        const healthIdx = str.indexOf('Health');
        if (healthIdx !== -1) {
          // TAG_Float follows the name, next 4 bytes are the float
          stats.health = Math.round(datBuf.readFloatBE(healthIdx + 7));
        }
      }
    } catch {
      // .dat may not exist
    }

    return res.json({ ok: true, stats });
  } catch (e) {
    logDebug(`[Player Stats] Error: ${e.message}`);
    return res.status(500).json({ ok: false, error: 'Failed to fetch player stats' });
  }
});

function sftpReadFileRaw(remotePath) {
  return new Promise((resolve, reject) => {
    if (!sftpConn) return reject(new Error('SFTP not connected'));
    sftpConn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(remotePath, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
  });
}

// ─── SFTP TAILING LOGIC (Cloudflare Bypass) ───────────────────────────────────
let sftpConn = null;
let sftpLastSize = 0;
let sftpPollInterval = null;

function startSftpTailing() {
  if (sftpConn) return;

  logDebug(`[SFTP] Initiating connection to ${SFTP_HOST}:${SFTP_PORT} as ${SFTP_USER}...`);
  sftpConn = new Client();

  sftpConn.on('ready', () => {
    logDebug('[SFTP] SSH Connection successful. Requesting SFTP...');
    serverInfo.status = 'online';
    broadcast({ type: 'serverInfo', data: serverInfo });

    sftpConn.sftp((err, sftp) => {
      if (err) {
        logDebug(`[SFTP] SFTP session failed: ${err.message}`);
        sftpConn.end();
        return;
      }

      logDebug('[SFTP] SFTP session ready. Tail monitoring started.');
      
      // Print files in the root folder to see structure
      sftp.readdir('.', (err, list) => {
        if (err) {
          logDebug(`[SFTP] readdir '.' failed: ${err.message}`);
        } else {
          const fileNames = list.map(f => f.filename).join(', ');
          logDebug(`[SFTP] Files in root folder: ${fileNames}`);
        }
      });

      sftp.readdir('plugins', (err, list) => {
        if (err) {
          logDebug(`[SFTP] readdir 'plugins' failed: ${err.message}`);
        } else {
          const fileNames = list.map(f => f.filename).join(', ');
          logDebug(`[SFTP] Files in plugins: ${fileNames}`);
        }
      });

      sftp.readdir('plugins/AuthMe', (err, list) => {
        if (err) {
          logDebug(`[SFTP] readdir 'plugins/AuthMe' failed: ${err.message}`);
        } else {
          const fileNames = list.map(f => f.filename).join(', ');
          logDebug(`[SFTP] Files in plugins/AuthMe: ${fileNames}`);
        }
      });

      const logFile = 'logs/latest.log'; // relative path without leading slash

      async function checkLog() {
        sftp.stat(logFile, (err, stats) => {
          if (err) {
            logDebug(`[SFTP] stat '${logFile}' failed: ${err.message}`);
            return;
          }

          if (sftpLastSize === 0) {
            logDebug(`[SFTP] Initializing tail. File size is ${stats.size} bytes.`);
            const size = stats.size;
            const start = Math.max(0, size - 12000);
            sftpReadChunk(sftp, logFile, start, size);
            sftpLastSize = size;
          } else if (stats.size > sftpLastSize) {
            sftpReadChunk(sftp, logFile, sftpLastSize, stats.size);
            sftpLastSize = stats.size;
          } else if (stats.size < sftpLastSize) {
            logDebug(`[SFTP] Log file size decreased (rotated or cleared). Resetting.`);
            sftpLastSize = 0;
          }
        });
      }

      sftpPollInterval = setInterval(checkLog, 2500);
      checkLog();
    });
  });

  sftpConn.on('error', err => {
    logDebug(`[SFTP] SSH connection error: ${err.message}`);
    cleanupSftp();
    setTimeout(startSftpTailing, 8000);
  });

  sftpConn.on('close', () => {
    logDebug('[SFTP] SSH connection closed. Retrying in 8s...');
    cleanupSftp();
    setTimeout(startSftpTailing, 8000);
  });

  try {
    sftpConn.connect({
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USER,
      privateKey: SFTP_KEY,
      readyTimeout: 15000,
    });
  } catch (e) {
    logDebug(`[SFTP] Connect fail: ${e.message}`);
    cleanupSftp();
  }
}

function cleanupSftp() {
  sftpConn = null;
  sftpLastSize = 0;
  if (sftpPollInterval) {
    clearInterval(sftpPollInterval);
    sftpPollInterval = null;
  }
}

function sftpReadChunk(sftp, path, start, end) {
  const length = end - start;
  if (length <= 0) return;
  const buffer = Buffer.alloc(length);

  sftp.open(path, 'r', (err, fd) => {
    if (err) return;
    sftp.read(fd, buffer, 0, length, start, (err, bytesRead) => {
      sftp.close(fd, () => {});
      if (err) return;
      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          pushLog(line);
        }
      });
    });
  });
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function boot() {
  if (SFTP_KEY) {
    logDebug('SFTP_PRIVATE_KEY found. Booting via SFTP direct log tailing (Bypassing Cloudflare)...');
    startSftpTailing();
  } else {
    logDebug('No SFTP_PRIVATE_KEY provided. Booting via Pterodactyl REST & WebSocket API...');
    const servers = await getServers();

    if (!servers.length) {
      logDebug('[Dashboard] No servers found or API blocked. Check your API key and panel URL.');
    } else {
      const first = servers[0].attributes;
      detectedServerId = first.identifier;
      serverInfo.name       = first.name || 'Minecrafter Gang SMP';
      serverInfo.maxPlayers = first.limits?.threads || 20;

      logDebug(`[Dashboard] Found server: "${first.name}" (ID: ${detectedServerId})`);
      logDebug('[Dashboard] Connecting to live console...');

      // Connect to console WebSocket
      connectConsole(detectedServerId);

      // Poll resources every 8 seconds
      setInterval(() => fetchResources(detectedServerId), 8000);
      fetchResources(detectedServerId);
    }
  }

  server.listen(PORT, () => {
    console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  });
}

boot();

