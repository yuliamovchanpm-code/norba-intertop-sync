const fetch = require('node-fetch');

const BASE_URL = 'https://openapi.keycrm.app/v1';
const API_KEY = process.env.KEYCRM_API_KEY;
const PAGE_LIMIT = 20; // менше = надійніше, за досвідом Norba Production v2
const RETRIES = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keycrmFetch(path, options = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          ...(options.headers || {}),
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`KeyCRM ${options.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(1200 * attempt);
    }
  }
  throw lastErr;
}

/**
 * Pull all offers (SKU-level stock) from KeyCRM catalog, paginated.
 * Returns [{ sku, quantity, barcode, productName, ... }]
 */
async function getAllOffers() {
  const offers = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const json = await keycrmFetch(`/offers?include=product&page=${page}&limit=${PAGE_LIMIT}`);
    const items = json?.data ?? [];
    if (items.length === 0) break;
    for (const item of items) {
      offers.push({
        sku: item.sku,
        barcode: item.barcode || null,
        quantity: item.quantity ?? 0,
        productName: item.product?.name || null,
      });
    }
    if (!json?.next_page_url && items.length < PAGE_LIMIT) break;
    page += 1;
    await sleep(300);
  }
  return offers;
}

const SOURCE_ID = process.env.KEYCRM_INTERTOP_SOURCE_ID;

/**
 * Create an order in KeyCRM from an Intertop order.
 * order: normalized shape, see orderSync.js buildKeycrmPayload()
 */
async function createOrder(payload) {
  if (!SOURCE_ID) throw new Error('KEYCRM_INTERTOP_SOURCE_ID не задано в env');
  const body = { source_id: Number(SOURCE_ID), ...payload };
  return keycrmFetch('/order', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Get a single order with shipping info (tracking_code, shipping_status).
 * status_id / status_group_id повертаються в базовому об'єкті без include.
 */
async function getOrder(id) {
  const json = await keycrmFetch(`/order/${id}?include=shipping`);
  return json?.data ?? json;
}

module.exports = { getAllOffers, createOrder, getOrder, keycrmFetch };
