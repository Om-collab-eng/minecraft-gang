# ⛏️ Minecrafter Gang — Server Dashboard

A beautiful, **real-time, read-only** web dashboard for your Minecraft server.

![dashboard](https://img.shields.io/badge/status-live-brightgreen) ![node](https://img.shields.io/badge/node-18%2B-blue) ![read--only](https://img.shields.io/badge/commands-disabled-orange)

## Features

| Feature | Details |
|---------|---------|
| 🖥️ Live Console | Streams your server's `latest.log` in real time |
| 👥 Online Players | Shows who's online with Minecraft avatars |
| 📡 Player Activity | Join / Leave / Death / Chat events with toasts |
| 📊 Server Stats | Status, TPS, Memory, Version, Player count |
| 🔒 Read-Only | No commands can ever be sent — safe to share |
| ✨ Animations | Particle background, animated status, micro-animations |

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Point to your Minecraft log
```bash
# Option A — environment variable (recommended)
MC_LOG_PATH=/path/to/your/minecraft-server/logs/latest.log node server.js

# Option B — edit the default in server.js line ~12
```

### 3. Start the dashboard
```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 4. Open in your browser
```
http://localhost:3000
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `MC_LOG_PATH` | `./logs/latest.log` | Path to your Minecraft server's `logs/latest.log` |
| `PORT` | `3000` | Port the dashboard listens on |

## Project Structure

```
minecrafter gang/
├── server.js          ← Node.js + Express + WebSocket backend
├── package.json
├── public/
│   ├── index.html     ← Dashboard UI
│   ├── style.css      ← Dark Minecraft-themed CSS
│   └── app.js         ← Frontend WebSocket client
└── README.md
```

## How It Works

1. The backend **tails your Minecraft log file** in real time using the `tail` package.
2. Each log line is **parsed** to detect player joins, leaves, deaths, chat, TPS, etc.
3. Events are broadcast over **WebSocket** to all connected browsers instantly.
4. The frontend **renders** the console and activity feed, and **never** sends anything back to the server.

## Security

- **Zero command execution** — WebSocket messages from clients are silently dropped.
- **Static frontend** — no user input is accepted or processed.
- **Read-only** — the dashboard can only observe, never control.

---

Made with ❤️ for the Minecrafter Gang SMP
