const keycrm = require('./keycrmClient');
const intertop = require('./intertopClient');
const { logSync } = require('../db');

async function runStockSync() {
  try {
    const offers = await keycrm.getAllOffers();
    // article і barcode обов'язкові для Intertop (PATCH /offers/quantity 422-ить
    // на весь батч, якщо серед офферів є хоч один без barcode) - відсіюємо
    // некомплектні офери, а не валимо весь sync.
    const relevant = offers.filter((o) => o.sku && o.barcode);
    const skipped = offers.filter((o) => o.sku && !o.barcode);

    const results = await intertop.updateOffersQuantity(
      relevant.map((o) => ({ article: o.sku, barcode: o.barcode, quantity: o.quantity }))
    );

    logSync('stock', 'ok', {
      offersTotal: relevant.length,
      skippedNoBarcode: skipped.length,
      skippedSkus: skipped.slice(0, 50).map((o) => o.sku),
      operations: results.map((r) => ({ operationId: r.operationId, batchSize: r.batchSize })),
    });
    return { offersTotal: relevant.length, skippedNoBarcode: skipped.length, operations: results };
  } catch (err) {
    logSync('stock', 'error', err.message);
    throw err;
  }
}

module.exports = { runStockSync };
