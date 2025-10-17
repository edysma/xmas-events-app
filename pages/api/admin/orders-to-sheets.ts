// pages/api/admin/orders-to-sheets.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// ---------- Google Sheets client ----------
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!;
  const jwt = new google.auth.JWT({ email, key, scopes: SCOPES });
  return google.sheets({ version: 'v4', auth: jwt });
}

async function appendRowsToSheet(rows: any[][]) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Raw!A:T',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// ---------- HMAC (Shopify) su RAW BODY ----------
function verifyShopifyHmacFromRaw(rawBody: string, secret: string, hmacHeader?: string) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// ---------- Helpers ----------
function toRomeISO(dateStr: string | undefined) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toISOString();
}
function safeString(x: any) { return x == null ? '' : String(x); }

function normTicketType(s: string) {
  const t = (s || '').toLowerCase();
  if (t.includes('adult')) return 'Adulto';
  if (t.includes('bambin') || t.includes('child') || t.includes('kid')) return 'Bambino';
  if (t.includes('disab') || t.includes('handicap') || t.includes('invalid')) return 'Disabilità';
  if (t.includes('unico') || t.includes('unique') || t.includes('singolo')) return 'Unico';
  return 'Sconosciuto';
}

function pickEventFrom(lineTitle: string, productTitle: string, orderTags: string[]) {
  const tags = orderTags.join(',').toLowerCase();
  if (tags.includes('evento:fantasynflora')) return 'FantaSynflora';
  if (tags.includes('evento:wondy')) return 'Wondy';
  const blob = `${lineTitle} ${productTitle}`.toLowerCase();
  if (blob.includes('wondy')) return 'Wondy';
  if (blob.includes('fanta')) return 'FantaSynflora';
  return 'Sconosciuto';
}

function extractDateSlot(li: any) {
  const props = Array.isArray(li.properties) ? li.properties : [];
  const propMap: Record<string, string> = {};
  for (const p of props) if (p?.name) propMap[String(p.name).toLowerCase()] = String(p.value ?? '');
  let date = propMap['data'] || propMap['date'] || '';
  let slot = propMap['orario'] || propMap['ora'] || propMap['slot'] || '';

  if ((!date || !slot) && typeof li.title === 'string') {
    const mDate = li.title.match(/(20\d{2}-\d{2}-\d{2})/);
    const mSlot = li.title.match(/\b(\d{1,2}:\d{2})\b/);
    if (!date && mDate) date = mDate[1];
    if (!slot && mSlot) slot = mSlot[1];
  }
  return { date, slot };
}

// ---------- Aggregazione per ordine×evento×data×slot ----------
function collectRowsFromOrder(order: any) {
  type Counts = { Adulto: number; Bambino: number; Disabilità: number; Unico: number; Sconosciuto: number };
  const buckets = new Map<string, {
    createdAt: string; orderName: string; orderId: string;
    customerName: string; customerEmail: string;
    event: string; date: string; slot: string;
    counts: Counts; qtyTotal: number;
    totalGross: number; currency: string; payGws: string; processedAt: string;
  }>();

  const createdAt = toRomeISO(order.created_at || order.processed_at || order.updated_at);
  const processedAt = toRomeISO(order.processed_at);
  const orderName = safeString(order.name);
  const orderId = safeString(order.id);
  const customerName = order?.customer ? `${safeString(order.customer.first_name)} ${safeString(order.customer.last_name)}`.trim() : '';
  const customerEmail = safeString(order?.email || order?.contact_email);
  const currency = safeString(order.currency);
  const totalGross = Number(order.total_price ?? 0);
  const payGws = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names.join(',') : '';

  const orderTags = (order.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  for (const li of lineItems) {
    if (li.gift_card === true) continue;

    const event = pickEventFrom(safeString(li.title), safeString(li.product_title), orderTags);
    const { date, slot } = extractDateSlot(li);
    const typeRaw = safeString(li.variant_title || li.title);
    let type = normTicketType(typeRaw);
    if (type.toLowerCase().includes('handicap')) type = 'Disabilità';

    const key = [orderId, event, date, slot].join('||');
    if (!buckets.has(key)) {
      buckets.set(key, {
        createdAt, orderName, orderId, customerName, customerEmail,
        event, date, slot,
        counts: { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 },
        qtyTotal: 0,
        totalGross, currency, payGws, processedAt,
      });
    }
    const b = buckets.get(key)!;
    const qty = Number(li.quantity || 0);
    b.qtyTotal += qty;
    if (type === 'Adulto') b.counts.Adulto += qty;
    else if (type === 'Bambino') b.counts.Bambino += qty;
    else if (type === 'Disabilità') b.counts.Disabilità += qty;
    else if (type === 'Unico') b.counts.Unico += qty;
    else b.counts.Sconosciuto += qty;
  }

  const rows: any[][] = [];
  for (const b of buckets.values()) {
    const mix = [
      `Adulto | ${b.counts.Adulto}`,
      `Bambino | ${b.counts.Bambino}`,
      `Disabilità | ${b.counts.Disabilità}`,
      `Unico | ${b.counts.Unico}`,
      `Sconosciuto | ${b.counts.Sconosciuto}`
    ].join(', ');

    rows.push([
      b.createdAt, b.orderName, b.orderId, b.customerName, b.customerEmail,
      b.event, b.date, b.slot,
      mix, b.counts.Adulto, b.counts.Bambino, b.counts.Disabilità, b.counts.Unico, b.counts.Sconosciuto, b.qtyTotal,
      b.totalGross, b.currency, b.payGws, b.processedAt,
    ]);
  }
  return rows;
}

// ---------- Disattiva il parser: ci serve il RAW body ----------
export const config = {
  api: {
    bodyParser: false,
  },
};

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const dryRun = String((req.query as any).dryRun || '') === '1';
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
    const isWebhook = Boolean(req.headers['x-shopify-topic']);

    // 1) Leggi RAW body
    const buf = await getRawBody(req);
    const rawBody = buf.toString('utf8');

    // 2) Verifica HMAC (solo per chiamate da Shopify)
    if (isWebhook) {
      if (!secret) return res.status(500).json({ ok: false, error: 'SHOPIFY_WEBHOOK_SECRET not set' });
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined;
      const ok = verifyShopifyHmacFromRaw(rawBody, secret, hmacHeader);
      if (!ok) return res.status(401).json({ ok: false, error: 'Invalid HMAC' });
    }

    // 3) Parse JSON
    let payload: any = {};
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }

    const order = payload && payload.id ? payload : null;
    if (!order) return res.status(400).json({ ok: false, error: 'Invalid payload: expected order object' });

    const rows = collectRowsFromOrder(order);

    if (dryRun) {
      return res.status(200).json({ ok: true, dryRun: true, preview_rows: rows });
    }

    if (rows.length > 0) await appendRowsToSheet(rows);
    return res.status(200).json({ ok: true, appended: rows.length });
  } catch (err: any) {
    console.error('orders-to-sheets error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
}
