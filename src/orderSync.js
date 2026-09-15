const keycrm = require('./keycrmClient');
const intertop = require('./intertopClient');
const { isOrderSynced, markOrderSynced, logSync } = require('../db');

// ID служби доставки "Нова Пошта" в KeyCRM (Налаштування -> Служби доставки,
// або GET /order/delivery-service) - потрібен, щоб warehouse_ref коректно
// підхопився як відділення НП.
const NP_DELIVERY_SERVICE_ID = process.env.KEYCRM_NP_DELIVERY_SERVICE_ID
  ? Number(process.env.KEYCRM_NP_DELIVERY_SERVICE_ID)
  : undefined;

function buildKeycrmPayload(order) {
  const buyer = order.client_data || order.customer_data || {};
  const delivery = order.delivery_data || {};

  const fullName = [buyer.last_name, buyer.name, buyer.second_name].filter(Boolean).join(' ');
  const isNovaPoshta = /novaposhta/i.test(delivery.service_code || '');

  const products = (order.offers || []).map((o) => ({
    sku: o.product_article,
    price: o.price,
    quantity: o.quantity,
  }));

  const payments = [];
  if (order.payment_data) {
    payments.push({
      payment_method: order.payment_data.payment_method || 'Intertop',
      amount: order.payment_data.amount,
      status: order.payment_data.payed ? 'paid' : 'not_paid',
      description: `Intertop замовлення №${order.number}`,
    });
  }

  return {
    source_uuid: order.number ? String(order.number) : undefined,
    manager_comment: `Imported from Intertop, order id ${order.id}`,
    buyer: {
      full_name: fullName || undefined,
      email: buyer.email || undefined,
      phone: buyer.phone ? String(buyer.phone) : undefined,
    },
    shipping: {
      shipping_service: 'Intertop / ' + (delivery.service_code || ''),
      shipping_address_city: delivery.city || undefined,
      shipping_address_country: delivery.country || undefined,
      shipping_receive_point: delivery.office || delivery.shop || undefined,
      tracking_code: delivery.waybill || undefined,
      // warehouse_ref спрацює тільки разом з delivery_service_id (НП);
      // для інших служб лишаємо тільки текстову адресу вище.
      ...(isNovaPoshta && delivery.warehous_ref && NP_DELIVERY_SERVICE_ID
        ? { delivery_service_id: NP_DELIVERY_SERVICE_ID, warehouse_ref: delivery.warehous_ref }
        : {}),
      recipient_full_name: fullName || undefined,
      recipient_phone: buyer.phone ? String(buyer.phone) : undefined,
    },
    products,
    payments,
  };
}

async function runOrderSync() {
  try {
    const newOrders = await intertop.getOrders({ status: 'new', limit: 50 });
    let created = 0;
    let skipped = 0;
    const errors = [];

    for (const orderSummary of newOrders) {
      if (isOrderSynced(orderSummary.id)) {
        skipped += 1;
        continue;
      }

      try {
        // getOrders() summary may be shallow - fetch full order for offers/delivery details
        const order = await intertop.getOrder(orderSummary.id);

        const payload = buildKeycrmPayload(order);
        const result = await keycrm.createOrder(payload);
        const keycrmOrderId = result?.data?.id ?? result?.id ?? null;

        markOrderSynced(order.id, order.number, keycrmOrderId, 'created');

        // Повідомляємо Intertop, що замовлення прийняте в роботу
        await intertop.updateOrderStatus(order.id, 'in_work');

        created += 1;
      } catch (err) {
        errors.push({ intertopOrderId: orderSummary.id, error: err.message });
        console.error(`[orderSync] замовлення ${orderSummary.id} не синхронізовано:`, err.message);
      }
    }

    logSync('orders', errors.length ? 'error' : 'ok', { found: newOrders.length, created, skipped, errors });
    return { found: newOrders.length, created, skipped, errors };
  } catch (err) {
    logSync('orders', 'error', err.message);
    throw err;
  }
}

module.exports = { runOrderSync, buildKeycrmPayload };
