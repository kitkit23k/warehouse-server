// ============================================================
// server.js - Render cloud server (English logs, MongoDB counters)
// 1. GET  /api/items/next?type=A|B|C   -> next item ID (counter + 1)
// 2. POST /api/items/result            -> ESP32 reports write result, counter saved to MongoDB
// 3. POST /api/esp32/report            -> ESP32 uploads data, forwarded to CodePen via WebSocket
// 4. GET  /api/items/counters          -> view current counters (for checking)
// 5. WebSocket server                  -> CodePen connects with wss://<your-domain>
//
// Environment variable required on Render: MONGODB_URI
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

// CORS: allow CodePen to call the REST API
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
// Counters: kept in memory for fast reads, saved to MongoDB so
// they survive restarts, redeploys and free-plan sleep.
// ------------------------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'warehouse';
const TYPES = ['A', 'B', 'C'];

const counters = { A: 0, B: 0, C: 0 };
let countersCol = null;

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI is not set. Counters will reset when the server restarts.');
    return;
  }

  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    countersCol = client.db(DB_NAME).collection('counters');

    const docs = await countersCol.find({}).toArray();
    for (const d of docs) {
      if (TYPES.includes(d._id)) {
        counters[d._id] = Math.max(counters[d._id], Number(d.value) || 0);
      }
    }

    // Persist any value that was only in memory before the connection succeeded
    for (const t of TYPES) {
      if (counters[t] > 0) {
        await countersCol.updateOne({ _id: t }, { $max: { value: counters[t] } }, { upsert: true });
      }
    }

    console.log('MongoDB connected. Counters loaded:', JSON.stringify(counters));
  } catch (err) {
    countersCol = null;
    console.error('MongoDB connection failed:', err.message);
    console.log('Retrying MongoDB connection in 15 seconds...');
    setTimeout(connectMongo, 15000);
  }
}

async function saveCounter(type, num) {
  if (num > counters[type]) counters[type] = num;

  if (!countersCol) {
    console.warn('MongoDB not connected, counter ' + type + ' kept in memory only');
    return;
  }

  try {
    // $max never lets the stored value go backwards
    await countersCol.updateOne({ _id: type }, { $max: { value: num } }, { upsert: true });
    console.log('Counter saved to MongoDB:', type, '=', counters[type]);
  } catch (err) {
    console.error('Failed to save counter to MongoDB:', err.message);
  }
}

// ------------------------------------------------------------
// REST API
// ------------------------------------------------------------
app.get('/api/items/next', (req, res) => {
  const type = (req.query.type || '').toUpperCase();
  if (!TYPES.includes(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  const nextNumber = counters[type] + 1;
  const itemId = `ITEM-${type}${String(nextNumber).padStart(3, '0')}`;
  res.json({ boxType: type, nextNumber, itemId });
});

app.post('/api/items/result', async (req, res) => {
  const { itemId, status } = req.body || {};
  console.log('Received write result:', itemId, status);

  if (status === 'success' && typeof itemId === 'string') {
    const match = itemId.match(/^ITEM-([A-C])(\d+)$/);
    if (match) {
      await saveCounter(match[1], parseInt(match[2], 10));
    }
  }

  // No broadcast here: CodePen gets the full data from /api/esp32/report
  res.json({ ok: true });
});

app.post('/api/esp32/report', (req, res) => {
  const data = req.body;
  console.log('Received ESP32 report:', JSON.stringify(data));

  broadcast(data);

  res.json({ ok: true, received: data });
});

app.get('/api/items/counters', (req, res) => {
  res.json({ counters, storage: countersCol ? 'mongodb' : 'memory' });
});

app.get('/', (req, res) => {
  res.send(
    'Warehouse server is running. WebSocket clients: ' + clients.size +
    ' | Storage: ' + (countersCol ? 'MongoDB' : 'memory only')
  );
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server started, listening on port ' + PORT);
  console.log('WebSocket server ready, CodePen should connect to wss://<your-domain>');
  connectMongo();
});
