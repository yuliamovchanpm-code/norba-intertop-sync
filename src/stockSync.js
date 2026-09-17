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
    // В KeyCRM залишок може бути від'ємним (продано більше, ніж оприбутковано),
    // Intertop приймає тільки quantity >= 0.
    const negative = relevant.filter((o) => o.quantity < 0);

    const { results, rejected } = await intertop.updateOffersQuantity(
      relevant.map((o) => ({ article: o.sku, barcode: o.barcode, quantity: Math.max(0, o.quantity) }))
    );

    const summary = {
      offersTotal: relevant.length,
      sent: relevant.length - rejected.length,
      skippedNoBarcode: skipped.length,
      skippedSkus: skipped.slice(0, 50).map((o) => o.sku),
      negativeClampedSkus: negative.map((o) => `${o.sku} (${o.quantity})`),
      rejected,
      operations: results.map((r) => ({ operationId: r.operationId, batchSize: r.batchSize })),
    };
    console.log('[stockSync]', JSON.stringify(summary));
    logSync('stock', rejected.length ? 'partial' : 'ok', summary);
    return summary;
  } catch (err) {
    logSync('stock', 'error', err.message);
    throw err;
  }
}

module.exports = { runStockSync };
