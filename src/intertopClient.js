const fetch = require('node-fetch');
const { getKV, setKV } = require('../db');

// PRODUCTION: https://api-partner.intertop.com/api/v2
// DEVELOP:    https://dev-api-partner.intertop.com/api/v2
const BASE_URL = process.env.INTERTOP_API_BASE || 'https://api-partner.intertop.com/api/v2';
const APP_KEY = process.env.INTERTOP_APP_KEY;
const APP_SECRET = process.env.INTERTOP_APP_SECRET;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Auth ---------------------------------------------------------------

async function requestNewToken() {
  const body = new URLSearchParams({ app_key: APP_KEY, app_secret: APP_SECRET });
  const res = await fetch(`${BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.access_token?.token) {
    throw new Error(`Intertop auth failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const { token, expires_date } = json.data.access_token;
  setKV('intertop_token', token);
  setKV('intertop_token_expires', String(expires_date));
  return token;
}

async function refreshToken(oldToken) {
  const res = await fetch(`${BASE_URL}/auth/token?token=${encodeURIComponent(oldToken)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.access_token?.token) {
    // refresh failed (e.g. old token too far expired) -> re-authenticate from scratch
    return requestNewToken();
  }
  const { token, expires_date } = json.data.access_token;
  setKV('intertop_token', token);
  setKV('intertop_token_expires', String(expires_date));
  return token;
}

/** Returns a valid bearer token, refreshing/re-authenticating as needed. */
async function getValidToken() {
  const token = getKV('intertop_token');
  const expiresAt = Number(getKV('intertop_token_expires') || 0);
  const nowSec = Math.floor(Date.now() / 1000);

  if (!token) return requestNewToken();
  // refresh 5 minutes before expiry
  if (expiresAt - nowSec < 300) return refreshToken(token);
  return token;
}

// --- Generic authenticated request --------------------------------------

async function intertopFetch(path, options = {}, _retry = true) {
  const token = await getValidToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));

  if (res.status === 401 && _retry) {
    // token might have just been invalidated - force re-auth once
    setKV('intertop_token', '');
    return intertopFetch(path, options, false);
  }
  if (!res.ok) {
    throw new Error(`Intertop ${options.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// --- Offers / quantity ----------------------------------------------------

const WAREHOUSE_EXTERNAL_ID = process.env.INTERTOP_WAREHOUSE_ID || 'default';

/**
 * Push quantity updates to Intertop in batches of <=1000, per API limit.
 * offers: [{ article, barcode, quantity }]
 * Returns array of { operationId, batchSize }.
 */
async function updateOffersQuantity(offers) {
  const BATCH = 1000;
  const results = [];
  for (let i = 0; i < offers.length; i += BATCH) {
    const batch = offers.slice(i, i + BATCH).map((o) => ({
      article: o.article,
      ...(o.barcode ? { barcode: o.barcode } : {}),
      quantity: o.quantity,
      warehouse_external_id: WAREHOUSE_EXTERNAL_ID,
    }));
    const json = await intertopFetch('/offers/quantity', {
      method: 'PATCH',
      body: JSON.stringify({ offers: batch }),
    });
    results.push({ operationId: json?.data?.id ?? json?.data?.operation_id, batchSize: batch.length, raw: json });
    await sleep(1200); // be gentle with the API between batches
  }
  return results;
}

async function getOperation(operationId) {
  return intertopFetch(`/operations/${operationId}`);
}

// --- Orders -----------------------------------------------------------

/**
 * Get orders by status. Intertop order statuses:
 * new | done | canceled | in_work | not_processed | assembled | shipping | shipped | delivery_error | revert
 */
async function getOrders({ status = 'new', limit = 50, offset = 0 } = {}) {
  const filter = encodeURIComponent(`status::${status}`);
  const json = await intertopFetch(`/orders/?filter=${filter}&sort=id&limit=${limit}&offset=${offset}`);
  const data = json?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function getOrder(orderId) {
  const json = await intertopFetch(`/orders/${orderId}/`);
  return json?.data;
}

/** status: 'in_work' | 'assembled' | ... ; extra can include waybill etc. */
async function updateOrderStatus(orderId, status, extra = {}) {
  return intertopFetch(`/orders/${orderId}/`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...extra }),
  });
}

module.exports = {
  getValidToken,
  updateOffersQuantity,
  getOperation,
  getOrders,
  getOrder,
  updateOrderStatus,
};
