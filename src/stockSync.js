const keycrm = require('./keycrmClient');
const intertop = require('./intertopClient');
const { logSync } = require('../db');

async function runStockSync() {
  try {
    const offers = await keycrm.getAllOffers();
    const relevant = offers.filter((o) => o.sku); // article обов'язковий для Intertop

    const results = await intertop.updateOffersQuantity(
      relevant.map((o) => ({ article: o.sku, barcode: o.barcode, quantity: o.quantity }))
    );

    logSync('stock', 'ok', {
      offersTotal: relevant.length,
      operations: results.map((r) => ({ operationId: r.operationId, batchSize: r.batchSize })),
    });
    return { offersTotal: relevant.length, operations: results };
  } catch (err) {
    logSync('stock', 'error', err.message);
    throw err;
  }
}

module.exports = { runStockSync };
