const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sync.db');

const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_map (
  intertop_order_id TEXT PRIMARY KEY,
  intertop_order_number TEXT,
  keycrm_order_id TEXT,
  status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,               -- 'stock' | 'orders' | 'status'
  status TEXT NOT NULL,            -- 'ok' | 'error'
  details TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// waybill додано пізніше - ALTER безпечний для вже існуючої бази
try {
  db.exec('ALTER TABLE order_map ADD COLUMN waybill TEXT');
} catch (e) {
  // колонка вже існує
}

function getKV(key) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setKV(key, value) {
  db.prepare(`
    INSERT INTO kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

function isOrderSynced(intertopOrderId) {
  return !!db.prepare('SELECT 1 FROM order_map WHERE intertop_order_id = ?').get(intertopOrderId);
}

function markOrderSynced(intertopOrderId, intertopOrderNumber, keycrmOrderId, status) {
  db.prepare(`
    INSERT INTO order_map (intertop_order_id, intertop_order_number, keycrm_order_id, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(intertop_order_id) DO UPDATE SET keycrm_order_id = excluded.keycrm_order_id, status = excluded.status
  `).run(String(intertopOrderId), String(intertopOrderNumber), String(keycrmOrderId), status);
}

/** Замовлення, які вже створені в KeyCRM, але ще не в фінальному статусі Intertop. */
function getPendingOrders() {
  return db.prepare(`
    SELECT * FROM order_map
    WHERE keycrm_order_id IS NOT NULL
      AND status NOT IN ('done', 'canceled', 'shipped', 'revert')
  `).all();
}

function updateOrderMapStatus(intertopOrderId, status, waybill) {
  db.prepare(`
    UPDATE order_map SET status = ?, waybill = ? WHERE intertop_order_id = ?
  `).run(status, waybill || null, String(intertopOrderId));
}

function logSync(job, status, details) {
  db.prepare('INSERT INTO sync_log (job, status, details) VALUES (?, ?, ?)')
    .run(job, status, typeof details === 'string' ? details : JSON.stringify(details));
}

function recentLogs(limit = 30) {
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  db,
  getKV,
  setKV,
  isOrderSynced,
  markOrderSynced,
  getPendingOrders,
  updateOrderMapStatus,
  logSync,
  recentLogs,
};
