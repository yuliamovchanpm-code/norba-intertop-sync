const keycrm = require('./keycrmClient');
const intertop = require('./intertopClient');
const { getPendingOrders, updateOrderMapStatus, logSync } = require('../db');

// status_id пайплайну KeyCRM (Налаштування -> Статуси замовлень), підтверджені Юлією.
const STATUS_ID_SHIPPED = Number(process.env.KEYCRM_STATUS_ID_SHIPPED || 8); // передано у доставку
const STATUS_ID_DELIVERED = Number(process.env.KEYCRM_STATUS_ID_DELIVERED || 27); // доставлено (на відділення)
const STATUS_ID_DONE = Number(process.env.KEYCRM_STATUS_ID_DONE || 26); // виконано, клієнт забрав
const STATUS_ID_CANCELED = Number(process.env.KEYCRM_STATUS_ID_CANCELED || 19); // скасовано
const STATUS_ID_RETURN = Number(process.env.KEYCRM_STATUS_ID_RETURN || 23); // повернення
const STATUS_ID_OUT_OF_STOCK = Number(process.env.KEYCRM_STATUS_ID_OUT_OF_STOCK || 15); // немає в наявності
// STATUS_ID_AVAILABILITY_CONFIRMED = 2 ("наявність підтверджено") - без дії,
// замовлення в Intertop вже "in_work" з моменту створення.

// Причина скасування в Intertop (GET /order/status -> cancel_reasons для статусу
// "canceled") - без цього ID автоскасування пропускається, лог позначає "потребує
// cancel_reason_id" замість здогадки.
const CANCEL_REASON_ID = process.env.INTERTOP_CANCEL_REASON_ID
  ? Number(process.env.INTERTOP_CANCEL_REASON_ID)
  : undefined;
const OUT_OF_STOCK_CANCEL_REASON_ID = process.env.INTERTOP_OUT_OF_STOCK_CANCEL_REASON_ID
  ? Number(process.env.INTERTOP_OUT_OF_STOCK_CANCEL_REASON_ID)
  : undefined;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Повертає { status, extra } для PATCH в Intertop, null - якщо дія не потрібна,
 * або { blocked: 'причина' } - якщо дія потрібна, але не вистачає даних.
 */
function resolveNextStatus(order, row) {
  const statusId = order?.status_id;
  const trackingCode = order?.shipping?.tracking_code || null;

  if (statusId === STATUS_ID_CANCELED) {
    if (!CANCEL_REASON_ID) return { blocked: 'скасовано в KeyCRM, але INTERTOP_CANCEL_REASON_ID не задано' };
    return { status: 'canceled', extra: { cancel_reason_id: CANCEL_REASON_ID } };
  }

  if (statusId === STATUS_ID_OUT_OF_STOCK) {
    if (!OUT_OF_STOCK_CANCEL_REASON_ID) {
      return { blocked: 'немає в наявності в KeyCRM, але INTERTOP_OUT_OF_STOCK_CANCEL_REASON_ID не задано' };
    }
    return { status: 'canceled', extra: { cancel_reason_id: OUT_OF_STOCK_CANCEL_REASON_ID } };
  }

  if (statusId === STATUS_ID_RETURN) {
    // revert_waybill обов'язковий для статусу "revert" в Intertop; в KeyCRM немає
    // окремого поля для трек-номера повернення (тільки tracking_code відправлення) -
    // автоматично не проставляємо, потрібне ручне підтвердження звідки брати номер.
    return { blocked: 'повернення в KeyCRM - потрібен revert_waybill, автоматизація не налаштована' };
  }

  if (statusId === STATUS_ID_DONE) {
    return { status: 'done', extra: {} };
  }

  if (statusId === STATUS_ID_DELIVERED) {
    // Посилка на відділенні - Intertop сам стежить за ТТН НП і власним трекінгом
    // переводить замовлення в "shipping"/"shipped"; нашого PATCH тут не треба.
    return null;
  }

  if (statusId === STATUS_ID_SHIPPED && trackingCode && trackingCode !== row.waybill) {
    // Waybill в Intertop можна зберегти лише разом зі статусом "assembled"
    return { status: 'assembled', extra: { waybill: trackingCode }, waybill: trackingCode };
  }

  return null;
}

async function runStatusSync() {
  try {
    const pending = getPendingOrders();
    let updated = 0;
    let skipped = 0;
    let blocked = 0;
    const errors = [];
    const blockedOrders = [];

    for (const row of pending) {
      try {
        const order = await keycrm.getOrder(row.keycrm_order_id);
        const next = resolveNextStatus(order, row);

        if (!next) {
          skipped += 1;
          continue;
        }
        if (next.blocked) {
          blocked += 1;
          blockedOrders.push({ intertopOrderId: row.intertop_order_id, reason: next.blocked });
          continue;
        }

        await intertop.updateOrderStatus(row.intertop_order_id, next.status, next.extra);
        updateOrderMapStatus(row.intertop_order_id, next.status, next.waybill || row.waybill);
        updated += 1;
      } catch (err) {
        errors.push({ intertopOrderId: row.intertop_order_id, error: err.message });
        console.error(`[statusSync] замовлення ${row.intertop_order_id} не оновлено:`, err.message);
      }
      await sleep(1200);
    }

    logSync('status', errors.length ? 'error' : 'ok', {
      checked: pending.length,
      updated,
      skipped,
      blocked,
      blockedOrders,
      errors,
    });
    return { checked: pending.length, updated, skipped, blocked, blockedOrders, errors };
  } catch (err) {
    logSync('status', 'error', err.message);
    throw err;
  }
}

module.exports = { runStatusSync };
