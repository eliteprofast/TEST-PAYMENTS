# TEST-PAYMENTS

A Node.js + Express payment service that processes PayPal checkouts for
[ElitezShop](../elitezshop). It renders the PayPal Smart Buttons, creates and
captures orders through the PayPal Checkout Server SDK, prices orders from a
server-side product catalog, and notifies an admin Discord channel when a
payment completes.

It also works standalone as a manual PayPal integration test harness (open
`/` with no query string) — hence the repo name.

For how this service connects to the shop frontend, see
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Currency: why orders charge in USD, not AED

PayPal's REST API does not support AED as a checkout currency at all (it's
absent from PayPal's [24-currency list](https://developer.paypal.com/reference/currency-codes/)
— confirmed against a real `CURRENCY_NOT_SUPPORTED` response, sandbox and
live alike). ElitezShop's product catalog and displayed prices stay in AED;
`server.js` converts to USD at order-creation time using the fixed AED↔USD
peg (`AED_TO_USD_RATE = 3.6725`, pegged since 1997 — not a live/floating
rate, so this needs no FX API). The checkout page shows both figures
("15.00 AED" / "≈ $4.08 USD") so the amount on PayPal's own approval screen
isn't a surprise. Verified end-to-end with a real sandbox capture.

## Tech stack

- Node.js, Express
- `@paypal/checkout-server-sdk` (PayPal Orders v2 API)
- Static HTML/CSS/JS frontend served by Express (no build step)
- In-memory order storage (see [Data storage](#data-storage))

## Project structure

```
TEST-PAYMENTS/
├── server.js         # Express app: PayPal orders, product catalog, Discord notifications
├── index.html         # Checkout page — manual test mode or cart handoff mode
├── success.html         # Post-payment confirmation
├── failed.html            # Post-payment failure page
├── package.json
├── render.yaml               # Render.com deploy config
├── .env.example                # Documented environment variables (safe to commit)
├── .env                          # Local secrets (gitignored, never committed)
└── docs/
    └── INTEGRATION.md              # Cross-repo architecture with ElitezShop
```

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
npm start
```

Open http://localhost:3000.

### Environment variables

| Variable                | Required | Description                                                                 |
|--------------------------|:--------:|-------------------------------------------------------------------------------|
| `PORT`                     | No       | Port to listen on. Defaults to `3000`.                                          |
| `PAYPAL_MODE`                | No       | `sandbox` or `live`. Defaults to `sandbox`.                                       |
| `PAYPAL_CLIENT_ID`             | Yes      | PayPal REST app client ID for the selected mode.                                    |
| `PAYPAL_CLIENT_SECRET`           | Yes      | PayPal REST app secret for the selected mode.                                         |
| `CURRENCY`                         | No       | 3-letter ISO currency code for **manual test mode only**. Defaults to `USD` (PayPal doesn't support AED — see [Currency](#currency-why-orders-charge-in-usd-not-aed)). Cart checkouts always charge USD regardless of this value. |
| `ADMIN_EMAIL`                        | No       | Informational; where order alerts are conceptually addressed.                             |
| `DISCORD_WEBHOOK_URL`                  | No       | Discord webhook for order notifications. Omit to disable Discord notifications.             |
| `AMOUNT`                                 | No       | Default amount pre-filled in manual test mode. Defaults to `10.00`.                           |
| `SENDGRID_API_KEY`                         | No       | Reserved for a future email-notification channel; not read by any code path yet. |

Get PayPal sandbox credentials at https://developer.paypal.com/dashboard/applications.

## Running locally

```bash
npm start
```

The server serves its own static files (no separate frontend build/dev
server) and exposes the API described below on the same origin.

## API reference

All endpoints are same-origin with the frontend; there is no authentication
layer (see [Security](#security)).

### `GET /health`
Says whether checkout can work at all: reports the PayPal mode/API base in use
and actually exchanges the configured credentials for an access token. Returns
`200` when they're valid, `503` with a `problem` string when they aren't. Never
returns the credentials themselves — only whether they're set and the last six
characters of the client ID.
```json
{ "ok": true, "configuredMode": "sandbox", "activeMode": "sandbox",
  "apiBase": "https://api.sandbox.paypal.com", "currency": "USD",
  "clientIdSet": true, "clientIdSuffix": "jTKRj8", "clientSecretSet": true,
  "discordWebhookSet": true, "problem": null }
```
If a shopper sees the "Payment Failed" page the moment they click PayPal, check
this first — a `401 invalid_client` means `PAYPAL_MODE` and the credential pair
disagree (sandbox keys only work in sandbox mode, live only in live).

`activeMode` differing from `configuredMode` means the server caught that
mismatch itself: `PAYPAL_MODE=live` holding sandbox credentials falls back to
sandbox so checkout keeps working, and logs a warning. The correction only ever
runs in that direction — a sandbox deploy holding live credentials is reported
as an error rather than silently promoted to charging real cards.

### `GET /config`
Returns the PayPal client ID and currency the frontend needs to render the
Smart Buttons (manual test mode default; cart mode overrides to USD client-side).
```json
{ "currency": "USD", "amount": "10.00", "clientId": "..." }
```

### `GET /products`
Returns the canonical product catalog (AED prices) plus the fixed AED→USD
conversion rate, so the client never needs its own copy of the peg constant.
```json
{
  "products": { "office-chair": { "name": "Office Chair", "price": 70 }, "...": {} },
  "displayCurrency": "AED",
  "chargeCurrency": "USD",
  "aedToUsdRate": 3.6725
}
```

### `POST /create-order`
Creates a PayPal order. Two mutually exclusive request shapes:

- **Cart checkout** (from ElitezShop): the server prices the order in AED
  from `PRODUCTS`, then converts to USD at `AED_TO_USD_RATE` — the client
  cannot influence the amount or the currency.
  ```json
  { "items": [{ "id": "office-chair", "quantity": 1 }] }
  ```
- **Manual test mode** (no `items` key): free-form amount/currency (from
  `CURRENCY`), for exercising the PayPal integration directly.
  ```json
  { "amount": "25.00" }
  ```

Response: `{ "id": "<paypal-order-id>" }`, or `400` if `items` references an
unknown product id.

### `POST /capture-order`
Captures a previously created PayPal order and records it.
```json
{
  "orderId": "<paypal-order-id>",
  "item": "Office Chair",
  "phoneNumber": "+9715XXXXXXXX",
  "deliveryLocation": "Downtown Dubai",
  "coordinates": "25.1972, 55.2744"
}
```
Returns the raw PayPal capture result. If the order originated from a cart
checkout, the recorded item list and amount come from the server-priced cart,
not from this request body — the stored record includes both the captured
USD amount and the original `amountAed` reference value. On success, a
Discord notification is sent (if `DISCORD_WEBHOOK_URL` is set) and the order
is appended to the in-memory `orders` array.

### `GET /orders`
Returns all captured orders from the in-memory store (see
[Data storage](#data-storage)). No authentication — do not expose this
endpoint's data to end users in production without adding access control.

### `GET /success`, `GET /failed`
Serve the post-payment confirmation/failure pages.

## Data storage

Orders are kept in an in-memory array (`orders` in `server.js`) — **they are
lost on every restart or deploy.** This is fine for a test/demo service; wire
up a real database before relying on this for order history.

## Security

- **Server-side pricing.** `/create-order` computes cart totals from the
  `PRODUCTS` catalog in `server.js`, not from client input, closing the
  obvious price-tampering hole a naive "pass the amount from the browser"
  design would have.
- **Secrets stay out of git.** `.env` is gitignored; only `.env.example`
  (placeholders) is committed. `render.yaml` marks all secret env vars
  `sync: false` so they're entered in the Render dashboard, never in the
  repo.
- **No auth on `/orders`.** Anyone who can reach the server can read all
  captured orders (names, emails, phone numbers, delivery coordinates). Put
  this behind auth (or remove it) before using this for real customer data.
- **`return` URL is only ever a clickable link,** never an automatic
  redirect, and is validated as an absolute `http(s)` URL before use — but it
  is still attacker-influenceable if someone crafts a checkout link by hand.
  Don't put anything sensitive in it.
- **PayPal credentials:** never commit real client ID/secret pairs, even to
  `.env.example`. Use placeholder text there.

## Deployment (Render)

`render.yaml` defines a Render Web Service:
```bash
Build Command: npm install
Start Command: npm start
```
Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ADMIN_EMAIL`, and
`DISCORD_WEBHOOK_URL` in the Render dashboard's Environment tab — they're
intentionally excluded from `render.yaml`. After deploying, update
`PAYMENT_SERVER_URL` in `elitezshop/cart.js` to this service's Render URL.
