// ============================================================
// server.js — Render cloud server (English log output version)
// Functions:
// 1. /api/items/next, /api/items/result (ESP32-A get ID / report write result)
// 2. /api/esp32/report: ESP32 uploads sensor data via HTTPS POST
// 3. WebSocket server: CodePen connects via wss:// to receive live data
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// CORS: allow CodePen domain to call the REST API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);

// ------------------------------------------------------------
// WebSocket server (for CodePen)
// CodePen connection URL: wss://warehouse-server-mv0z.onrender.com
// ------------------------------------------------------------
const wss = new WebSocket.Server({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('WebSocket client connected, total connections =', clients.size);

  ws.send(JSON.stringify({ type: 'hello', message: 'Connected to warehouse server' }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('WebSocket client disconnected, total connections =', clients.size);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ------------------------------------------------------------
// Item ID sequence logic (in-memory counters)
// ------------------------------------------------------------
const counters = { A: 0, B: 0, C: 0 };

app.get('/api/items/next', (req, res) => {
  const type = (req.query.type || '').toUpperCase();
  if (!['A', 'B', 'C'].includes(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  const nextNumber = counters[type] + 1;
  const itemId = `ITEM-${type}${String(nextNumber).padStart(3, '0')}`;
  res.json({ boxType: type, nextNumber, itemId });
});

app.post('/api/items/result', (req, res) => {
  const { itemId, status } = req.body;
  console.log('Received write result:', itemId, status);

  if (status === 'success' && itemId) {
    const match = itemId.match(/^ITEM-([A-C])(\d+)$/);
    if (match) {
      const type = match[1];
      const num = parseInt(match[2], 10);
      if (num > counters[type]) counters[type] = num;
    }
  }

  // Broadcast to CodePen so the frontend knows ESP32-A finished writing
  broadcast({
    type: 'write_complete',
    itemId,
    status
  });

  res.json({ ok: true });
});

// ------------------------------------------------------------
// ESP32 sensor data report endpoint
// Used by ESP32-A (laser + RC522) or ESP32-B (6 readers)
// ------------------------------------------------------------
app.post('/api/esp32/report', (req, res) => {
  const data = req.body;
  console.log('Received ESP32 report:', JSON.stringify(data));

  // Forward the received JSON to all connected CodePen clients
  broadcast(data);

  res.json({ ok: true, received: data });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Warehouse server is running. WebSocket clients: ' + clients.size);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server started, listening on port ' + PORT);
  console.log('WebSocket server ready, CodePen should connect to wss://<your-domain>');
});
