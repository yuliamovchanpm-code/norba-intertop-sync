require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const { recentLogs } = require('./db');
const { runStockSync } = require('./src/stockSync');
const { runOrderSync } = require('./src/orderSync');
const { runStatusSync } = require('./src/statusSync');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- health & logs ---------------------------------------------------

app.get('/', (req, res) => res.json({ ok: true, service: 'norba-intertop-sync' }));

app.get('/api/logs', (req, res) => {
  res.json(recentLogs(50));
});

// --- manual trigger endpoints (для дебагу / кнопки в майбутньому UI) --

app.post('/api/sync/stock', async (req, res) => {
  try {
    const result = await runStockSync();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync/orders', async (req, res) => {
  try {
    const result = await runOrderSync();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync/status', async (req, res) => {
  try {
    const result = await runStatusSync();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`norba-intertop-sync running on port ${PORT}`);
});

// --- cron schedules ----------------------------------------------------
// Залишки: раз на годину (Intertop оновлення асинхронне, немає сенсу частіше)
const STOCK_CRON = process.env.STOCK_SYNC_CRON || '0 * * * *';
// Замовлення: раз на 15 хв
const ORDERS_CRON = process.env.ORDERS_SYNC_CRON || '*/15 * * * *';
// ТТН/статуси: раз на 15 хв, зі зсувом, щоб не бити KeyCRM тими самими хвилинами що orders
const STATUS_CRON = process.env.STATUS_SYNC_CRON || '5-59/15 * * * *';

cron.schedule(STOCK_CRON, () => {
  console.log('[cron] stock sync start');
  runStockSync().catch((err) => console.error('[cron] stock sync failed:', err.message));
});

cron.schedule(ORDERS_CRON, () => {
  console.log('[cron] order sync start');
  runOrderSync().catch((err) => console.error('[cron] order sync failed:', err.message));
});

cron.schedule(STATUS_CRON, () => {
  console.log('[cron] status sync start');
  runStatusSync().catch((err) => console.error('[cron] status sync failed:', err.message));
});
