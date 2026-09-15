// ============================================================
// server.js — Render 雲端伺服器
// 功能：
// 1. 原有的 /api/items/next、/api/items/result（ESP32-A 取號 / 回報寫入結果）
// 2. 新增 /api/esp32/report：ESP32 用 HTTPS POST 上傳感測資料
// 3. 新增 WebSocket server：CodePen 用 wss:// 連線即時接收資料
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// CORS：允許 CodePen 網域打 API（若有其他 REST 需求）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);

// ------------------------------------------------------------
// WebSocket server（給 CodePen 連線）
// CodePen 端連線網址：wss://warehouse-server-mv0z.onrender.com
// ------------------------------------------------------------
const wss = new WebSocket.Server({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('WebSocket 客戶端已連線，目前連線數 =', clients.size);

  ws.send(JSON.stringify({ type: 'hello', message: '已連線到倉庫系統伺服器' }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('WebSocket 客戶端已斷線，目前連線數 =', clients.size);
  });

  ws.on('error', (err) => {
    console.error('WebSocket 錯誤:', err.message);
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
// 既有邏輯：貨品編號流水號（沿用你原本的實作，這裡示範記憶體版本）
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
  console.log('收到寫入結果:', itemId, status);

  if (status === 'success' && itemId) {
    const match = itemId.match(/^ITEM-([A-C])(\d+)$/);
    if (match) {
      const type = match[1];
      const num = parseInt(match[2], 10);
      if (num > counters[type]) counters[type] = num;
    }
  }

  // 同步廣播給 CodePen，讓網頁知道 ESP32-A 寫卡完成
  broadcast({
    type: 'write_complete',
    itemId,
    status
  });

  res.json({ ok: true });
});

// ------------------------------------------------------------
// 新增：ESP32 感測資料上報端點
// ESP32-A（雷射 + RC522）或 ESP32-B（6 顆讀取器）都可以打這支
// ------------------------------------------------------------
app.post('/api/esp32/report', (req, res) => {
  const data = req.body;
  console.log('收到 ESP32 上報:', JSON.stringify(data));

  // 直接把收到的 JSON 轉發給所有連線的 CodePen 前端
  broadcast(data);

  res.json({ ok: true, received: data });
});

// 健康檢查用
app.get('/', (req, res) => {
  res.send('Warehouse server is running. WebSocket clients: ' + clients.size);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server 已啟動，監聽 port ' + PORT);
  console.log('WebSocket server 已就緒，CodePen 請連線 wss://<你的網域>');
});
