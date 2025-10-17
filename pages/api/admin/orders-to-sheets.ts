// pages/api/admin/orders-to-sheets.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { google } from 'googleapis';

// ---------- Config ----------
export const config = {
  api: {
    // IMPORTANTE: niente bodyParser -> ci prendiamo il RAW body per l'HMAC
    bodyParser: false,
  },
};

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// ---------- Google Sheets ----------
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!;
  key = key.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  if (!key.startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY non è un PEM valido.');
  }
  const jwt = new google.auth.JWT({ email, key, scopes: SCOPES });
  return google.sheets({ version: 'v4', auth: jwt });
}

async function appendRowsToSheet(rows: any[][]) {
  if (!rows.length) return;
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

// ---------- Utils comuni (come nel backfill) ----------
type Counts = { Adulto: number; Bambino: number; Disabilità: number; Unico: number; Sconosciuto: number };
const safeString = (x: any) => (x == null ? '' : String(x));
const toRomeISO = (s?: string) => (s ? new Date(s).toISOString() : '');

function normTicketType(src: string) {
  const t = (src || '').toLowerCase();
  if (t.includes('adult')) return 'Adulto';
  if (/(bambin|child|kid)/.test(t)) return 'Bambino';
  if (/(disab|handicap|invalid)/.test(t)) return 'Disabilità';
  if (/(unico|unique|singol)/.test(t)) return 'Unico';
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
  let date = propMap['data'] || propMap['date'] || propMap['event_date'] || '';
  let slot = propMap['orario'] || propMap['ora'] || propMap['slot'] || propMap['slot_label'] || '';

  if ((!date || !slot) && typeof li.title === 'string') {
    const mDate = li.title.match(/(20\d{2}-\d{2}-\d{2})/);
    const mSlot = li.title.match(/\b(\d{1,2}:\d{2})\b/);
    if (!date && mDate) date = mDate[1];
    if (!slot && mSlot) slot = mSlot[1];
  }
  return { date, slot };
}

function countTypesFromProperties(li: any): { counts: Counts; total: number; used: boolean; sawHandicapHint: boolean } {
  const counts: Counts = { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 };
  let used = false;
  let sawHandicapHint = false;

  const props = Array.isArray(li.properties) ? li.properties : [];
  const entries = props.map((p: any) => ({
    k: String(p?.name ?? '').toLowerCase().trim(),
    v: String(p?.value ?? '').toLowerCase().trim(),
  }));

  const inc = (label: keyof Counts, n = 1) => { (counts as any)[label] += n; used = true; };
  const has = (s: string, re: RegExp) => re.test(s);

  const R_ADULTO = /adult/;
  const R_BAMBINO = /(bambin|child|kid)/;
  const R_DISAB   = /(disab|handicap|invalid)/;
  const R_UNICO   = /(unico|unique|singol)/;
  const R_TIPO_FIELD = /(tipo|tipologia|tariffa|ticket|categoria|bigliett|ingresso|label)/;

  for (const { k, v } of entries) {
    if (has(v, R_DISAB) || has(k, R_DISAB)) sawHandicapHint = true;

    if (has(v, R_ADULTO)) { inc('Adulto'); continue; }
    if (has(v, R_BAMBINO)) { inc('Bambino'); continue; }
    if (has(v, R_DISAB))   { inc('Disabilità'); continue; }
    if (has(v, R_UNICO))   { inc('Unico'); continue; }

    if (has(k, R_ADULTO)) { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Adulto', n); continue; }
    if (has(k, R_BAMBINO)) { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Bambino', n); continue; }
    if (has(k, R_DISAB))   { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Disabilità', n); continue; }
    if (has(k, R_UNICO))   { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Unico', n); continue; }

    if (has(k, R_TIPO_FIELD) && v) {
      let t = 'Sconosciuto';
      if (R_ADULTO.test(v)) t = 'Adulto';
      else if (R_BAMBINO.test(v)) t = 'Bambino';
      else if (R_DISAB.test(v))   t = 'Disabilità';
      else if (R_UNICO.test(v))   t = 'Unico';
      inc(t as keyof Counts);
      continue;
    }
  }

  const total = counts.Adulto + counts.Bambino + counts.Disabilità + counts.Unico + counts.Sconosciuto;
  return { counts, total, used, sawHandicapHint };
}

function classifyFromPrice(li: any, sawHandicapHint: boolean): { counts: Counts; totalPeople: number; used: boolean } {
  const counts: Counts = { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 };
  const qty = Number(li.quantity || 0);
  const priceStr = String(li.price || li.price_set?.shop_money?.amount || '').replace(',', '.').trim();
  const price = parseFloat(priceStr);
  if (!qty || isNaN(price)) return { counts, totalPeople: 0, used: false };

  if (Math.abs(price - 9) < 0.001) { counts.Bambino += qty; return { counts, totalPeople: qty, used: true }; }
  if (Math.abs(price - 11) < 0.001) {
    if (sawHandicapHint) { counts.Disabilità += qty; return { counts, totalPeople: qty * 2, used: true }; }
    counts.Adulto += qty; return { counts, totalPeople: qty, used: true };
  }
  return { counts, totalPeople: qty, used: false };
}

function collectRowsFromOrder(order: any) {
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
  const customerName = ''; // niente PII sul piano attuale
  const customerEmail = '';
  const currency = safeString(order.currency);
  const totalGross = Number(order.total_price ?? 0);
  const payGws = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names.join(',') : '';

  const orderTags = (order.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  for (const li of lineItems) {
    if (li.gift_card === true) continue;

    const event = pickEventFrom(safeString(li.title), safeString(li.product_title), orderTags);
    const { date, slot } = extractDateSlot(li);

    const viaProps = countTypesFromProperties(li);
    const sawHandicapHint =
      viaProps.sawHandicapHint ||
      /(disab|handicap|invalid)/i.test(String(li.title || '')) ||
      /(disab|handicap|invalid)/i.test(String(li.name || ''));

    let usedPeople = 0;
    if (!viaProps.used) {
      const byPrice = classifyFromPrice(li, sawHandicapHint);
      if (byPrice.used) {
        viaProps.counts.Adulto      += byPrice.counts.Adulto;
        viaProps.counts.Bambino     += byPrice.counts.Bambino;
        viaProps.counts.Disabilità  += byPrice.counts.Disabilità;
        viaProps.counts.Unico       += byPrice.counts.Unico;
        viaProps.counts.Sconosciuto += byPrice.counts.Sconosciuto;
        usedPeople = byPrice.totalPeople;
      }
    }
    if (!viaProps.used && usedPeople === 0) {
      const source = safeString(li.variant_title) || safeString(li.title) || safeString(li.sku);
      let t = normTicketType(source);
      if (/(handicap|disab)/i.test(t)) t = 'Disabilità';
      if (t === 'Sconosciuto') t = 'Unico';
      (viaProps.counts as any)[t] += Number(li.quantity || 0);
      usedPeople = Number(li.quantity || 0);
    }

    const key = [orderId, event, date, slot].join('||');
    if (!buckets.has(key)) {
      buckets.set(key, {
        createdAt, orderName, orderId, customerName, customerEmail,
        event, date, slot,
        counts: { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 },
        qtyTotal: 0, totalGross, currency, payGws, processedAt,
      });
    }
    const b = buckets.get(key)!;
    const addPeople = usedPeople || Number(li.quantity || 0);
    b.qtyTotal += addPeople;
    b.counts.Adulto      += viaProps.counts.Adulto;
    b.counts.Bambino     += viaProps.counts.Bambino;
    b.counts.Disabilità  += viaProps.counts.Disabilità;
    b.counts.Unico       += viaProps.counts.Unico;
    b.counts.Sconosciuto += viaProps.counts.Sconosciuto;
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

// ---------- HMAC (Shopify) ----------
function timingSafeEq(a: string, b: string) {
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function verifyHmacFromRaw(raw: Buffer, secret: string, header: string | undefined) {
  if (!header) return false;
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  return timingSafeEq(digest, header);
}

// ---------- Raw body helper ----------
async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const isWebhook = Boolean(req.headers['x-shopify-topic']);
    const dryRun = String((req.query as any).dryRun || '') === '1';
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';

    // 1) Leggi RAW body (necessario sia per HMAC che per parsing)
    const raw = await readRawBody(req);
    const payload = raw.length ? JSON.parse(raw.toString('utf8')) : null;

    // 2) Se è webhook Shopify, verifica HMAC
    if (isWebhook) {
      if (!secret) return res.status(500).json({ ok: false, error: 'SHOPIFY_WEBHOOK_SECRET non configurato' });
      const ok = verifyHmacFromRaw(raw, secret, req.headers['x-shopify-hmac-sha256'] as string | undefined);
      if (!ok) return res.status(401).json({ ok: false, error: 'Invalid HMAC' });
    }

    // 3) Prendi l’ordine dal payload
    const order = payload && payload.id ? payload : null;
    if (!order) return res.status(400).json({ ok: false, error: 'Invalid payload: expected order object' });

    // 4) Trasforma → righe
    const rows = collectRowsFromOrder(order);

    // 5) dryRun o scrittura
    if (dryRun) return res.status(200).json({ ok: true, dryRun: true, preview_rows: rows });
    if (rows.length > 0) await appendRowsToSheet(rows);

    return res.status(200).json({ ok: true, appended: rows.length });
  } catch (err: any) {
    console.error('orders-to-sheets error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
}
