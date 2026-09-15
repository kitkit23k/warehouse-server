// ============================================================
// server.js
// 本地測試用 server，對應 ESP32-A 的 Item ID 查詢與寫入回報
//
// 使用方式：
//   1. 安裝 Node.js（https://nodejs.org）
//   2. 在這個檔案所在資料夾開終端機，執行：npm init -y && npm install express
//   3. 執行：node server.js
//   4. 確認電腦和 ESP32 連同一個 Wi-Fi/熱點
//   5. 用 ipconfig 查電腦 IP，填進 ESP32 程式的 SERVER_URL
// ============================================================

const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.json());

// 記錄每個型號目前最大編號（重啟 server 後會清空，只是測試用）
const itemCounters = {
  A: 0,
  B: 0,
  C: 1   // 模擬已經有 ITEM-C001 存在
};

const writeLog = [];

function makeItemId(boxType, number) {
  const padded = String(number).padStart(3, '0');
  return `ITEM-${boxType}${padded}`;
}

// GET /api/items/next?type=C
app.get('/api/items/next', (req, res) => {
  const boxType = (req.query.type || '').toUpperCase();

  if (!['A', 'B', 'C'].includes(boxType)) {
    return res.status(400).json({ error: 'type 必須是 A, B 或 C' });
  }

  const nextNumber = itemCounters[boxType] + 1;
  itemCounters[boxType] = nextNumber;

  const itemId = makeItemId(boxType, nextNumber);

  console.log(`[GET /api/items/next] type=${boxType} -> ${itemId}`);

  res.json({
    boxType: boxType,
    nextNumber: nextNumber,
    itemId: itemId
  });
});

// POST /api/items/result
app.post('/api/items/result', (req, res) => {
  const { itemId, status } = req.body;

  if (!itemId || !status) {
    return res.status(400).json({ error: '需要 itemId 和 status' });
  }

  writeLog.push({
    itemId,
    status,
    time: new Date().toISOString()
  });

  console.log(`[POST /api/items/result] itemId=${itemId} status=${status}`);

  res.json({ received: true });
});

// 方便你在瀏覽器直接查看目前狀態
app.get('/api/items/status', (req, res) => {
  res.json({
    counters: itemCounters,
    writeLog: writeLog
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server 已啟動，監聽 port ${PORT}`);
  console.log(`本機測試網址：http://localhost:${PORT}/api/items/next?type=C`);
  console.log(`請用 ipconfig 查詢你電腦在目前網路的 IP，填入 ESP32 程式的 SERVER_URL`);
});
