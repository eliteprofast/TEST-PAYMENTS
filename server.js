const express = require("express");
const path = require("path");
const paypal = require("@paypal/checkout-server-sdk");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
// PayPal's REST API does not support AED as a checkout currency at all (it's
// absent from their 24-currency list, sandbox or live) — confirmed by an
// actual CURRENCY_NOT_SUPPORTED response from PayPal. USD is the safe
// cross-account default; AED only survives as ElitezShop's *display* currency
// (see PRODUCTS / AED_TO_USD_RATE below).
// The currencies PayPal accepts for a checkout order. AED is deliberately
// absent (see above) — an unsupported CURRENCY value is coerced to USD at boot
// rather than left to fail every order with CURRENCY_NOT_SUPPORTED.
const PAYPAL_CURRENCIES = new Set([
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY",
  "MYR", "MXN", "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD", "SEK", "CHF",
  "THB", "USD"
]);

const requestedCurrency = (process.env.CURRENCY || "USD").toUpperCase();
const currency = PAYPAL_CURRENCIES.has(requestedCurrency) ? requestedCurrency : "USD";
if (currency !== requestedCurrency) {
  console.warn(`CURRENCY=${requestedCurrency} is not a PayPal-supported checkout currency — falling back to USD.`);
}
const paypalMode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();
const adminEmail = process.env.ADMIN_EMAIL || "ali.eliteprofast@gmail.com";
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";

// AED has been fixed-pegged to USD at this exact rate since 1997 (it does not
// float), so converting a fixed AED catalog price to USD needs no live FX
// lookup — this constant is correct indefinitely, not a rate that goes stale.
const AED_TO_USD_RATE = 3.6725;

// Canonical product catalog — the single source of truth for pricing, in AED
// to match ElitezShop's displayed prices. IDs mirror the `data-product-id`
// attributes on the ElitezShop product cards (see elitezshop/index.html).
// The server always computes order totals from here (converted to USD for
// the actual PayPal charge, since PayPal can't hold AED); a client-supplied
// amount is only trusted in manual test mode (see /create-order), never for
// a cart checkout.
const PRODUCTS = {
  "office-chair": { name: "Office Chair", price: 70.00 },
  "wimpy-kid": { name: "Wimpy Kid Book", price: 15.00 },
  "hp-keyboard": { name: "HP Gaming Keyboard", price: 35.00 }
};

// In-memory order storage (use a real database in production)
const orders = [];
// PayPal order id -> resolved cart, kept between /create-order and
// /capture-order so the captured order record reflects what was actually
// priced server-side, not whatever the client claims.
const pendingOrders = new Map();

// Validates a client-submitted cart against PRODUCTS and clamps quantities.
// Returns null if any line item references an unknown product, so the
// caller can reject the whole request rather than silently dropping items.
function resolveCartItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const resolved = [];
  for (const entry of items) {
    const product = entry && PRODUCTS[entry.id];
    if (!product) return null;
    const quantity = Math.max(1, Math.min(20, Math.trunc(Number(entry.quantity)) || 1));
    resolved.push({ id: entry.id, name: product.name, price: product.price, quantity });
  }
  return resolved;
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Trimmed on the way in. A credential pasted into a hosting dashboard very
// easily picks up a trailing newline or space, and PayPal rejects the result
// as invalid_client — indistinguishable from a genuinely wrong secret, and it
// took the whole checkout down once already.
const clientId = (process.env.PAYPAL_CLIENT_ID || "").trim();
const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || "").trim();

if (!clientId || !clientSecret) {
  console.warn("PayPal credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your environment.");
}

// The credentials actually in use. The browser's PayPal SDK is handed
// activeClientId via /config, so it always matches whatever the server
// authenticates with — a mismatch there breaks checkout just as thoroughly.
let activeClientId = clientId;
let activeClientSecret = clientSecret;

function makeEnvironment(mode) {
  return mode === "live"
    ? new paypal.core.LiveEnvironment(activeClientId, activeClientSecret)
    : new paypal.core.SandboxEnvironment(activeClientId, activeClientSecret);
}

// `activeMode` is what we actually talk to PayPal with — usually PAYPAL_MODE,
// but see verifyCredentials() for the one case where it corrects itself.
let activeMode = paypalMode;
let environment = makeEnvironment(activeMode);
let client = new paypal.core.PayPalHttpClient(environment);
// Non-null once we know checkout can't work, so requests fail with a real
// reason instead of an opaque 500 on every click.
let credentialProblem = null;

console.log(
  `PayPal mode=${paypalMode} api=${environment.baseUrl} ` +
  `clientId=${clientId ? `…${clientId.slice(-6)} (${clientId.length} chars)` : "MISSING"} ` +
  `clientSecret=${clientSecret ? `set (${clientSecret.length} chars)` : "MISSING"} currency=${currency}`
);

// Exchanges one credential pair for an access token against one mode's API —
// the same call the SDK makes before every order. Returns null on success.
async function tryAuth(mode, id = activeClientId, secret = activeClientSecret) {
  if (!id || !secret) return "credentials not set";
  const baseUrl = mode === "live" ? "https://api.paypal.com" : "https://api.sandbox.paypal.com";
  try {
    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });
    if (response.ok) return null;
    const body = await response.json().catch(() => ({}));
    return `HTTP ${response.status} ${body.error || ""}`.trim();
  } catch (error) {
    return `could not reach PayPal: ${error.message}`;
  }
}

// Point the SDK client at a given mode and credential pair.
function activate(mode, id, secret) {
  activeMode = mode;
  activeClientId = id;
  activeClientSecret = secret;
  environment = makeEnvironment(activeMode);
  client = new paypal.core.PayPalHttpClient(environment);
  credentialProblem = null;
}

// Sandbox credentials deployed with PAYPAL_MODE=live (or the reverse) fail
// every order with an opaque 401 — the failure this whole page-level "Payment
// Failed" bug came from. Verify at boot, and if live mode rejects credentials
// that sandbox accepts, drop to sandbox so checkout keeps working.
//
// The correction is deliberately one-way. Promoting a deploy to live mode on
// our own would start charging real cards on a service the operator believes
// is in test mode, so a sandbox deploy holding live credentials is reported
// as a hard error instead.
async function verifyCredentials() {
  // 1. The host's own credentials in the configured mode — the normal path.
  const problem = clientId && clientSecret ? await tryAuth(paypalMode, clientId, clientSecret) : "credentials not set";
  if (!problem) {
    activate(paypalMode, clientId, clientSecret);
    console.log(`✅ PayPal credentials verified (${activeMode}).`);
    return;
  }

  // 2. Host credentials that only PayPal's sandbox accepts, deployed as live.
  //    Drop to sandbox rather than fail — never the reverse (see above).
  if (paypalMode === "live" && clientId && clientSecret && !(await tryAuth("sandbox", clientId, clientSecret))) {
    activate("sandbox", clientId, clientSecret);
    console.warn(
      `⚠ PAYPAL_MODE=live but these are sandbox credentials (live said ${problem}). ` +
      `Running in SANDBOX — no real money will move. Fix PAYPAL_MODE, or set live credentials, to take real payments.`
    );
    return;
  }

  credentialProblem =
    `PayPal rejected the credentials in ${paypalMode} mode (${problem}). ` +
    (paypalMode === "live"
      ? "Check PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are a matching pair from the same live PayPal app."
      : "Check PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are a matching pair from the same PayPal app.");
  console.error(`❌ PayPal credential check FAILED — checkout will not work. ${credentialProblem}`);
}

// Order routes await this so the very first click can't race the check (and
// can't be served by a client we're about to replace).
const paypalReady = verifyCredentials();

// Diagnostic endpoint: `curl <host>/health` says whether checkout can work at
// all, without exposing the credentials themselves.
app.get("/health", async (_req, res) => {
  // Re-check rather than trust the boot result: credentials can be rotated in
  // the host's dashboard without a restart.
  await verifyCredentials();
  res.status(credentialProblem ? 503 : 200).json({
    ok: !credentialProblem,
    configuredMode: paypalMode,
    activeMode,
    apiBase: environment.baseUrl,
    currency,
    clientIdSet: Boolean(clientId),
    clientIdSuffix: activeClientId ? activeClientId.slice(-6) : null,
    clientIdLength: clientId.length,
    clientSecretSet: Boolean(clientSecret),
    // Lengths and a whitespace flag pin down a mangled paste — a PayPal client
    // id and secret are both 80 characters. Neither reveals the credential.
    clientSecretLength: clientSecret.length,
    credentialsHadSurroundingWhitespace:
      (process.env.PAYPAL_CLIENT_ID || "") !== clientId ||
      (process.env.PAYPAL_CLIENT_SECRET || "") !== clientSecret,
    discordWebhookSet: Boolean(discordWebhookUrl),
    problem: credentialProblem
  });
});

app.get("/config", async (_req, res) => {
  // Wait for the credential check: the browser's SDK must be handed the client
  // id the server actually authenticates with, which the check may still be
  // deciding on at boot.
  await paypalReady;
  res.json({
    currency,
    amount: process.env.AMOUNT || "10.00",
    clientId: activeClientId
  });
});

app.get("/orders", (_req, res) => {
  res.json(orders);
});

app.get("/products", (_req, res) => {
  res.json({
    products: PRODUCTS,
    displayCurrency: "AED",
    chargeCurrency: "USD",
    aedToUsdRate: AED_TO_USD_RATE
  });
});

// Escape user-supplied text so it can't break (or inject into) the email HTML.
function escapeHtml(value) {
  return String(value == null || value === "" ? "NOT PROVIDED" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function notifyOrderToDiscord(order) {
  if (!discordWebhookUrl) {
    console.warn("DISCORD_WEBHOOK_URL is not configured — skipping Discord notification.");
    return;
  }

  const mapsLink = order.coordinates
    ? `https://www.google.com/maps?q=${encodeURIComponent(order.coordinates)}`
    : null;

  const embed = {
    title: "💰 New Payment Received!",
    color: 5763719, // green
    fields: [
      { name: "Item", value: order.item || "NOT PROVIDED", inline: true },
      {
        name: "Amount",
        value: order.amountAed
          ? `${order.amount} ${order.currency} (${order.amountAed} AED)`
          : `${order.amount} ${order.currency}`,
        inline: true
      },
      { name: "Phone", value: order.phoneNumber || "NOT PROVIDED", inline: true },
      { name: "Location", value: order.deliveryLocation || "NOT PROVIDED", inline: false },
      { name: "Coordinates", value: order.coordinates || "NOT PROVIDED", inline: false },
      { name: "Payer Name", value: order.payerName || "NOT PROVIDED", inline: true },
      { name: "Payer Email", value: order.payerEmail || "NOT PROVIDED", inline: true },
      { name: "PayPal Order ID", value: order.paypalOrderId || "N/A", inline: false },
      { name: "Time", value: new Date(order.timestamp).toLocaleString(), inline: false }
    ],
    ...(mapsLink && { url: mapsLink })
  };

  await fetch(discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  }).then(res => {
    if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
    console.log(`✅ Order ${order.id} sent to Discord`);
  });
}

// The PayPal SDK reports API failures as an Error whose `message` is the raw
// JSON body. Pull out the parts worth showing/logging (issue code + debug id,
// never credentials) so a failure is diagnosable instead of just "Failed".
function describePayPalError(error) {
  let body = {};
  try {
    body = JSON.parse(error.message);
  } catch {
    // Auth failures and network errors aren't JSON — fall through to the status code.
  }
  const issue = body.details?.[0]?.issue;
  const code = issue || body.name || body.error || (error.statusCode ? `HTTP_${error.statusCode}` : "UNKNOWN");
  const detail = error.statusCode === 401 || body.error === "invalid_client"
    ? `PayPal rejected the server's credentials in ${activeMode} mode.`
    : body.details?.[0]?.description || body.message || "";
  return { code, detail: [detail, body.debug_id && `debug_id ${body.debug_id}`].filter(Boolean).join(" ") };
}

app.post("/create-order", async (req, res) => {
  try {
    await paypalReady;
    if (credentialProblem) {
      return res.status(503).json({ error: "Checkout is temporarily unavailable.", code: "PAYPAL_NOT_CONFIGURED" });
    }

    let amount, orderCurrency, description, cartItems = null, amountAed = null;

    if (req.body.items !== undefined) {
      // Cart checkout handed off from ElitezShop: { items: [{ id, quantity }] }.
      // Price comes only from PRODUCTS — an unknown id fails the whole request
      // instead of silently falling back to a client-supplied amount.
      cartItems = resolveCartItems(req.body.items);
      if (!cartItems) {
        return res.status(400).json({ error: "Invalid cart items." });
      }
      const totalAed = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      amountAed = totalAed.toFixed(2);
      // PRODUCTS is priced in AED, but PayPal can't hold AED — always charge
      // the fixed-peg USD equivalent here, regardless of the CURRENCY env var
      // (that var only governs manual test mode below).
      amount = (totalAed / AED_TO_USD_RATE).toFixed(2);
      orderCurrency = "USD";
      description = cartItems.map(i => `${i.name} x${i.quantity}`).join(", ").slice(0, 127);
    } else {
      // Manual test mode (index.html dropdown with no cart handoff): free-form
      // amount, used to exercise the PayPal integration directly.
      amount = Number(req.body.amount || process.env.AMOUNT || "10.00").toFixed(2);
      orderCurrency = currency;
    }

    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
      intent: "CAPTURE",
      application_context: {
        shipping_preference: "NO_SHIPPING",
        // NO_PREFERENCE lets PayPal open on the login screen with the card
        // option underneath. "BILLING" forced everyone straight into the guest
        // card form, which dead-ends if their phone is tied to an account.
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW"
      },
      purchase_units: [{
        amount: { currency_code: orderCurrency, value: amount },
        ...(description && { description })
      }]
    });

    const order = await client.execute(request);
    if (cartItems) {
      pendingOrders.set(order.result.id, { items: cartItems, amount, currency: orderCurrency, amountAed });
    }
    res.json({ id: order.result.id });
  } catch (error) {
    const { code, detail } = describePayPalError(error);
    console.error(`Create order failed [${code}]:`, error.message);
    res.status(500).json({ error: "Unable to create PayPal order.", code, detail });
  }
});

app.post("/capture-order", async (req, res) => {
  try {
    await paypalReady;
    const { orderId, item, phoneNumber, deliveryLocation, coordinates } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});
    const capture = await client.execute(request);
    const result = capture.result;

    // Money is now captured. Record the order and notify the admin using the
    // amount PayPal actually took, not the value the browser claimed.
    const captured = result.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
    const payer = result.payer || {};

    // If this order was created from a cart handoff, prefer the server-priced
    // item list over whatever the client sends here — that list is what was
    // actually charged.
    const pending = pendingOrders.get(orderId);
    pendingOrders.delete(orderId);
    const itemSummary = pending
      ? pending.items.map(i => `${i.name} x${i.quantity}`).join(", ")
      : (item || "");

    const order = {
      id: Date.now().toString(),
      paypalOrderId: result.id,
      amount: captured?.value || pending?.amount || req.body.amount || "unknown",
      currency: captured?.currency_code || currency,
      amountAed: pending?.amountAed || null,
      item: itemSummary,
      items: pending?.items || null,
      phoneNumber: phoneNumber || "",
      deliveryLocation: deliveryLocation || "",
      coordinates: coordinates || "",
      payerName: [payer.name?.given_name, payer.name?.surname].filter(Boolean).join(" "),
      payerEmail: payer.email_address || "",
      timestamp: new Date().toISOString(),
      status: "pending"
    };

    orders.push(order);

    // Never let a notification failure break a completed payment.
    try {
      await notifyOrderToDiscord(order);
    } catch (notifyError) {
      console.error(`Order ${order.id} captured but DISCORD NOTIFICATION FAILED:`, notifyError.message);
      console.log("Order details:", JSON.stringify(order, null, 2));
    }

    res.json(result);
  } catch (error) {
    const { code, detail } = describePayPalError(error);
    console.error(`Capture order failed [${code}]:`, error.message);
    res.status(500).json({ error: "Unable to capture PayPal order.", code, detail });
  }
});

app.get("/success", (_req, res) => {
  res.sendFile(path.join(__dirname, "success.html"));
});

app.get("/failed", (_req, res) => {
  res.sendFile(path.join(__dirname, "failed.html"));
});

app.listen(port, () => console.log(`Server running on port ${port}`));
