# norba-intertop-sync

Двосторонній конектор між KeyCRM і Intertop Marketplace:

- **Залишки → Intertop**: раз на годину (cron) тягне всі offers з KeyCRM
  (`GET /offers?include=product`) і пушить кількості пакетно через
  `PATCH /offers/quantity` (до 1000 офферів/виклик, асинхронна операція).
- **Замовлення ← Intertop**: раз на 15 хв тягне нові замовлення
  (`GET /orders/?filter=status::new`), створює відповідне замовлення в KeyCRM
  (окреме джерело "Intertop") і позначає замовлення в Intertop як `in_work`.
- **ТТН і статуси → Intertop**: раз на 15 хв (зі зсувом) перевіряє всі
  синхронізовані замовлення, що ще не в фінальному статусі. Тягне замовлення
  з KeyCRM (`GET /order/{id}?include=shipping`) і за `status_id` пайплайну
  KeyCRM визначає дію в Intertop:
  | KeyCRM status_id | Значення | Дія в Intertop |
  |---|---|---|
  | 2 | наявність підтверджено | — (замовлення вже `in_work` з моменту створення) |
  | 8 | передано у доставку | `PATCH status: "assembled"` + `waybill` (трек-код НП) |
  | 27 | доставлено (на відділенні) | — (Intertop сам стежить за ТТН НП) |
  | 26 | виконано, клієнт забрав | `PATCH status: "done"` |
  | 19 | скасовано | `PATCH status: "canceled"` + `cancel_reason_id` (потрібен `INTERTOP_CANCEL_REASON_ID`) |
  | 23 | повернення | `PATCH status: "revert"` — **поки не автоматизовано**, бракує `revert_waybill` |
  | 15 | немає в наявності | `PATCH status: "canceled"` + `cancel_reason_id` (потрібен `INTERTOP_OUT_OF_STOCK_CANCEL_REASON_ID`) |

  Без відповідного `cancel_reason_id` в env — скасування/"немає в наявності"
  просто пропускаються з позначкою `blocked` в лозі (`GET /api/logs`), а не
  проштовхуються навмання.

Архітектурно — окремий сервіс на Railway (не модуль всередині Norba Production v2),
за зразком `Norba-production` (Express + better-sqlite3 + node-cron, SQLite на
persistent volume).

## Що треба зробити перед першим деплоєм

1. **KeyCRM**
   - Налаштування → Джерела → створити нове джерело "Intertop", записати його `id`
     → `KEYCRM_INTERTOP_SOURCE_ID`.
   - API-ключ KeyCRM (той самий, що й у Norba Production v2) → `KEYCRM_API_KEY`.
   - Переконатись, що товари в каталозі KeyCRM мають артикул (`sku`), який
     **точно збігається** з "Артикул продавця" (article) в кабінеті Intertop —
     інакше залишки не змапляться. Бажано, щоб офери мали ще й штрихкод (`barcode`).

2. **Intertop** (кабінет продавця → Розробникам/API)
   - Отримати `app_key` / `app_secret` → `INTERTOP_APP_KEY` / `INTERTOP_APP_SECRET`.
   - Перевірити: чи не прив'язаний зараз XML-фід цін/залишків
     (Товари → Завантаження товарів → Завантажити ціни). Якщо прив'язаний —
     відв'язати, інакше `PATCH /offers/quantity` повертатиме 422.
   - Уточнити код складу (`warehouse_external_id`), якщо він відрізняється від
     `"default"` → `INTERTOP_WAREHOUSE_ID`.
   - Почати з DEV-стенду (`INTERTOP_API_BASE=https://dev-api-partner.intertop.com/api/v2`),
     переключити на прод тільки після тестового прогону.

3. **Railway**
   - Новий проект → підключити GitHub-репо цього сервісу.
   - Додати **Volume**, Mount Path `/data`.
   - Додати всі змінні з `.env.example` у Variables.
   - Feature Flags → Skipped Builds → **вимкнено** (як і в production-v2).

## Відкриті питання

- Номер замовлення Intertop передається в KeyCRM через `source_uuid`
  ("Номер замовлення у джерелі") — має з'являтись поруч із номером KeyCRM.
- Ліміт KeyCRM API — 20 запитів/хв на ключ (пауза між запитами ≥3с). При великій
  кількості нових замовлень чи офферів це варто врахувати (зараз пауза між
  пачками для Intertop — 1.2с, для KeyCRM пагінації офферів — 0.3с; для
  створення замовлень пауз між запитами поки немає, додати при потребі).
- "Повернення" (KeyCRM status_id 23 → Intertop "revert") не автоматизовано:
  Intertop вимагає `revert_waybill` для цього статусу, а в KeyCRM немає
  окремого поля під трек-номер повернення (тільки `tracking_code` відправлення).
  Треба уточнити в Юлії, звідки брати цей номер — тоді додати сюди.
- `cancel_reason_id` для "Скасовано" (19) і "Немає в наявності" (15) —
  потрібні конкретні ID причин з кабінету Intertop (`GET /order/status` →
  `cancel_reasons` для статусу `canceled`). Без них ці два переходи логуються
  як `blocked`, а не проштовхуються з довільною причиною.

## Ручний запуск (для дебагу)

```
POST /api/sync/stock
POST /api/sync/orders
POST /api/sync/status
GET  /api/logs
```

## Структура

```
server.js             — Express + cron
db.js                  — SQLite (токен Intertop, мапа замовлень, лог синхронізацій)
src/intertopClient.js  — auth, offers/quantity, orders (Intertop API v2)
src/keycrmClient.js    — offers listing, order creation/fetch (KeyCRM API v1)
src/stockSync.js       — KeyCRM offers -> Intertop quantity
src/orderSync.js       — Intertop orders -> KeyCRM order
src/statusSync.js      — KeyCRM order status/ТТН -> Intertop order status
```
