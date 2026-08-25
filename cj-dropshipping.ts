// CJ Dropshipping API client.
// Docs: https://developers.cjdropshipping.com/
//
// Auth: CJ_EMAIL + CJ_API_KEY (in .env) are the durable credentials, used to
// bootstrap a session via /authentication/getAccessToken. The resulting
// accessToken/refreshToken are cached on StoreSettings (mutable runtime
// state, not .env) and refreshed automatically before they expire. A fresh
// email+apiKey login is only needed again if the refresh token itself
// expires (much longer-lived than the access token).

import { prisma } from './db';
import { COUNTRY_TO_ISO_CODE } from './currency';

const CJ_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1';
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh a day before expiry, not right at the wire

async function loginWithCredentials() {
  const email = process.env.CJ_EMAIL;
  const apiKey = process.env.CJ_API_KEY;
  if (!email || !apiKey) throw new Error('CJ_EMAIL / CJ_API_KEY not configured');

  const res = await fetch(`${CJ_BASE_URL}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: apiKey }),
  });
  const data = await res.json();
  if (!data.result || !data.data?.accessToken) {
    throw new Error(`CJ login failed: ${data.code} ${data.message}`);
  }
  return data.data as {
    accessToken: string;
    accessTokenExpiryDate: string;
    refreshToken: string;
    refreshTokenExpiryDate: string;
  };
}

async function refreshWithToken(refreshToken: string) {
  const res = await fetch(`${CJ_BASE_URL}/authentication/refreshAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json();
  if (!data.result || !data.data?.accessToken) {
    throw new Error(`CJ refresh failed: ${data.code} ${data.message}`);
  }
  return data.data as {
    accessToken: string;
    accessTokenExpiryDate: string;
    refreshToken: string;
    refreshTokenExpiryDate: string;
  };
}

async function getValidAccessToken(): Promise<string> {
  const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });

  const stillValid =
    settings?.cjAccessToken &&
    settings.cjAccessTokenExpiresAt &&
    settings.cjAccessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;
  if (stillValid) return settings!.cjAccessToken!;

  const refreshStillValid =
    settings?.cjRefreshToken &&
    settings.cjRefreshTokenExpiresAt &&
    settings.cjRefreshTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS;

  const result = refreshStillValid
    ? await refreshWithToken(settings!.cjRefreshToken!)
    : await loginWithCredentials();

  await prisma.storeSettings.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      cjAccessToken: result.accessToken,
      cjRefreshToken: result.refreshToken,
      cjAccessTokenExpiresAt: new Date(result.accessTokenExpiryDate),
      cjRefreshTokenExpiresAt: new Date(result.refreshTokenExpiryDate),
    },
    update: {
      cjAccessToken: result.accessToken,
      cjRefreshToken: result.refreshToken,
      cjAccessTokenExpiresAt: new Date(result.accessTokenExpiryDate),
      cjRefreshTokenExpiresAt: new Date(result.refreshTokenExpiryDate),
    },
  });

  return result.accessToken;
}

async function cjHeaders() {
  return {
    'CJ-Access-Token': await getValidAccessToken(),
    'Content-Type': 'application/json',
  };
}

// Pulls current price + stock for a CJ product. Call this on a schedule
// (e.g. hourly cron) rather than on every page load — CJ's rate limits are
// modest, and your DB should be the source of truth the storefront reads from.
export async function fetchCJProduct(cjProductId: string) {
  const res = await fetch(`${CJ_BASE_URL}/product/query?pid=${cjProductId}`, {
    headers: await cjHeaders(),
  });
  if (!res.ok) throw new Error(`CJ product fetch failed: ${res.status}`);
  const data = await res.json();
  return data.data; // { productName, sellPrice, variants: [...], ... } — shape per CJ docs
}

// Preferred carrier when CJ actually offers it for the route — the one
// normally used when placing orders manually through CJ's own portal.
const PREFERRED_LOGISTIC_NAME = 'cjpacket asia ordinary';

// Looks up a valid CJ shipping carrier for this destination + product mix.
// createOrderV2 requires a logisticName and rejects the request outright if
// it's missing or unavailable for the route, so this has to be queried
// per-order rather than hardcoded — carrier availability varies by product
// and destination. Prefers CJPacket Asia Ordinary when CJ offers it for this
// order; otherwise falls back to whatever's cheapest, so an unavailable
// preferred carrier never blocks the order outright.
async function resolveLogisticName(
  countryCode: string,
  products: { sku: string; quantity: number }[],
): Promise<string> {
  const res = await fetch(`${CJ_BASE_URL}/logistic/freightCalculate`, {
    method: 'POST',
    headers: await cjHeaders(),
    body: JSON.stringify({
      startCountryCode: 'CN',
      endCountryCode: countryCode,
      products: products.map((p) => ({ quantity: p.quantity, variantSku: p.sku })),
    }),
  });
  if (!res.ok) throw new Error(`CJ freight calculation failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.result || !data.data?.length) {
    throw new Error(`No CJ shipping option available for ${countryCode}: ${data.message || 'unknown reason'}`);
  }
  const preferred = data.data.find((opt: { logisticName: string }) => opt.logisticName.toLowerCase() === PREFERRED_LOGISTIC_NAME);
  if (preferred) return preferred.logisticName;

  const cheapest = [...data.data].sort((a, b) => a.logisticPrice - b.logisticPrice)[0];
  return cheapest.logisticName;
}

// CJ validates phone numbers per-country (e.g. India requires exactly 12
// digits starting with the "91" calling code, not the bare 10-digit local
// number our checkout collects). Strips everything but digits, then adds
// the calling code if it looks like a bare local number.
// COUNTRY_TO_ISO_CODE only covers the ~13 countries we support currencies
// for, but the checkout's country dropdown (CHECKOUT_COUNTRIES) offers many
// more. For those, complete-order.ts already leaves the raw ISO code in
// place (e.g. "MY" for Malaysia) rather than forcing it into a full name we
// don't have a mapping for. Recognize that case directly instead of
// silently defaulting to India, which was wrong for any unsupported country.
function resolveCountryCode(country: string | undefined): string {
  if (!country) return 'IN';
  if (/^[A-Z]{2}$/i.test(country)) return country.toUpperCase();
  return COUNTRY_TO_ISO_CODE[country] || 'IN';
}

function formatPhoneForCJ(phone: string, countryCode: string): string {
  const digits = phone.replace(/\D/g, '');
  if (countryCode === 'IN') {
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
  }
  return digits;
}

// A missing name otherwise blocks CJ submission entirely with
// "shippingCustomerName must be not empty" and needs a manual retry every
// time — our checkout requires a name, but this stays as a safety net for
// older orders and admin-created ones. Always "Customer" rather than
// something derived from the email, per explicit request.
function fallbackNameFromEmail(_email: string): string {
  return 'Customer';
}

// CJ rejects shippingAddress/shippingAddress2 over 100 characters outright
// ("shippingAddress only within 100 characters") — customers sometimes paste
// long, landmark-heavy addresses into a single line. Truncating is safer
// than losing the whole order to a hard rejection; the courier still gets
// the pincode/phone to fall back on.
function capAddressLine(line: string): string {
  return line.length > 100 ? line.slice(0, 100) : line;
}

// Submits a paid order to CJ for fulfillment. Called from the Razorpay
// verify webhook once payment is confirmed.
//
// Product identification: CJ's createOrderV2 accepts a variant `sku` in lieu
// of their internal `vid` ("vid and sku cannot both be null. When vid is
// missing, sku will be used to query the CJ variant" — CJ API docs). Every
// CJ-sourced product in our catalog already carries that CJ SKU (format
// "CJ..."), imported alongside the product itself — no separate vid lookup
// or product-mapping step is needed. Line items whose SKU doesn't start
// with "CJ" are non-CJ products (locally fulfilled) and are left out of the
// CJ order entirely.
export async function submitOrderToCJ(order: any): Promise<string | null> {
  const products = order.items
    .filter((item: any) => /^cj/i.test(item.variant?.sku || ''))
    .map((item: any) => ({
      sku: item.variant.sku,
      quantity: item.quantity,
      storeLineItemId: item.id,
    }));

  if (products.length === 0) return null; // nothing in this order is CJ-fulfilled

  const address = order.shippingAddress as {
    name?: string; email?: string; phone?: string;
    line1?: string; line2?: string; city?: string; state?: string; pincode?: string; country?: string;
  };

  // CJ also rejects submissions with no email at all (must look like an
  // email). Falls back to an order-traceable synthetic address rather than
  // blocking submission on a field Razorpay sometimes just doesn't return.
  const email = address.email || `order-${order.id}@glamgalore.in`;

  const countryCode = resolveCountryCode(address.country);
  let logisticName: string;
  try {
    logisticName = await resolveLogisticName(countryCode, products);
  } catch (err) {
    // A delisted/unavailable product in the order can make freight
    // calculation fail entirely, blocking submission before CJ ever sees it.
    // Fall back to the preferred carrier and submit anyway — CJ will flag
    // whatever it can't actually fulfill into its own "invalid orders"
    // section instead of the order silently never reaching CJ at all.
    console.error('Freight calculation failed, submitting anyway with fallback carrier:', order.id, err);
    logisticName = PREFERRED_LOGISTIC_NAME;
  }

  const payload = {
    orderNumber: order.invoiceNumber || order.id,
    shippingCustomerName: address.name || fallbackNameFromEmail(address.email || ''),
    shippingAddress: capAddressLine(address.line1 || ''),
    shippingAddress2: capAddressLine(address.line2 || ''),
    shippingCity: address.city || '',
    shippingProvince: address.state || '',
    shippingCountry: address.country || '',
    shippingCountryCode: countryCode,
    shippingZip: address.pincode || '',
    shippingPhone: address.phone ? formatPhoneForCJ(address.phone, countryCode) : '',
    email,
    fromCountryCode: 'CN', // required by CJ — all our dropshipped products ship from their China warehouses
    logisticName,
    products,
  };

  const res = await fetch(`${CJ_BASE_URL}/shopping/order/createOrderV2`, {
    method: 'POST',
    headers: await cjHeaders(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CJ order submission failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.result) throw new Error(`CJ order submission failed: ${data.code} ${data.message}`);
  return data.data.orderId;
}

// Polls tracking status for an order already submitted to CJ. CJ has no
// dedicated tracking-lookup endpoint — trackNumber/trackingProvider are
// fields on the order detail response, null until CJ marks it shipped.
// Wire this into a scheduled job that updates Order.trackingNumber and
// notifies the customer once tracking is available.
export async function fetchCJTracking(cjOrderId: string) {
  const res = await fetch(`${CJ_BASE_URL}/shopping/order/getOrderDetail?orderId=${cjOrderId}`, {
    headers: await cjHeaders(),
  });
  if (!res.ok) throw new Error(`CJ tracking fetch failed: ${res.status}`);
  const data = await res.json();
  if (!data.result) throw new Error(`CJ tracking fetch failed: ${data.code} ${data.message}`);
  return data.data; // { trackNumber, trackingProvider, trackingUrl, ... }
}
