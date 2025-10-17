// pages/api/admin/orders-to-sheets.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { google } from 'googleapis';

// ---------- Config ----------
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

type Counts = { Adulto: number; Bambino: number; Disabilità: number; Unico: number; Sconosciuto: number };

// ---------- Google Sheets client (private key normalizzata) ----------
function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!;
  key = key.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  if (!key.startsWith('-----BEGIN PRIVATE KEY-----') || !key.endsWith('-----END PRIVATE KEY-----')) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY non è un PEM valido (BEGIN/END).');
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

// ---------- HMAC (Shopify) ----------
function verifyShopifyHmac(req: NextApiRequest, secret: string) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined;
  if (!hmacHeader) return false;
  const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
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

// --- Parser riepilogo note_attributes["_Riepilogo biglietti"] ---
function parseNoteSummary(text: string) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const entries: Array<{ event?: string; date?: string; slot?: string; counts: Counts }> = [];

  const countFromFragment = (frag: string) => {
    const c: Counts = { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 };
    const re = /([A-Za-zÀ-ÿ]+)\s*[×x]\s*(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(frag)) !== null) {
      const label = m[1].toLowerCase();
      const n = parseInt(m[2], 10);
      if (/adult/.test(label)) c.Adulto += n;
      else if (/(bambin|child|kid)/.test(label)) c.Bambino += n;
      else if (/(disab|handicap|invalid)/.test(label)) c.Disabilità += n;
      else if (/(unico|unique|singol)/.test(label)) c.Unico += n;
      else c.Sconosciuto += n;
    }
    return c;
  };

  for (const ln of lines) {
    const arrow = ln.split('→');
    if (arrow.length >= 2) {
      const left = arrow[0].trim();
      const right = arrow.slice(1).join('→').trim();

      let event = '';
      const partEvt = left.split('—')[0]?.trim();
      if (partEvt && /wondy|fanta/i.test(partEvt)) event = partEvt;

      let date = '';
      let slot = '';
      const mIso = left.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
      const mIt = left.match(/(\d{1,2}\/\d{1,2}\/20\d{2})\s+(\d{1,2}:\d{2})/);
      if (mIso) { date = mIso[1]; slot = mIso[2]; }
      else if (mIt) {
        const [d, m, y] = mIt[1].split('/');
        date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
        slot = mIt[2];
      }

      const counts = countFromFragment(right);
      entries.push({ event, date, slot, counts });
    }
  }

  if (!entries.length && lines.length) {
    entries.push({ counts: countFromFragment(lines[lines.length - 1]) });
  }
  return entries;
}

function getNoteSummaryEntries(order: any) {
  const notes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const entry = notes.find((n: any) => String(n?.name).trim().toLowerCase() === '_riepilogo biglietti');
  return entry ? parseNoteSummary(String(entry.value)) : [];
}

function guessEventFromOrder(order: any, orderTags: string[]) {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  for (const li of lineItems) {
    const ev = pickEventFrom(safeString(li.title), safeString(li.product_title), orderTags);
    if (ev !== 'Sconosciuto') return ev;
  }
  return 'Sconosciuto';
}

// --- Conteggio tipi dalle PROPERTIES del line item (usa quantity se trova l'etichetta) ---
function countTypesFromProperties(li: any): { counts: Counts; total: number; used: boolean } {
  const counts: Counts = { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 };
  let used = false;
  const qty = Number(li.quantity || 0);

  const props = Array.isArray(li.properties) ? li.properties : [];
  const entries = props.map((p: any) => ({
    k: String(p?.name ?? '').toLowerCase().trim(),
    v: String(p?.value ?? '').toLowerCase().trim(),
  }));

  const has = (s: string, re: RegExp) => re.test(s);
  const R_ADULTO = /adult/;
  const R_BAMBINO = /(bambin|child|kid)/;
  const R_DISAB  = /(disab|handicap|invalid)/;
  const R_TIPO_FIELD = /(tipo|tipologia|tariffa|ticket|categoria|bigliett|ingresso|label)/;

  for (const { k, v } of entries) {
    if (has(v, R_ADULTO) || (has(k, R_TIPO_FIELD) && has(v, R_ADULTO))) { counts.Adulto += qty; used = true; break; }
    if (has(v, R_BAMBINO) || (has(k, R_TIPO_FIELD) && has(v, R_BAMBINO))) { counts.Bambino += qty; used = true; break; }
    if (has(v, R_DISAB)  || (has(k, R_TIPO_FIELD) && has(v, R_DISAB)))  { counts.Disabilità += qty; used = true; break; }
  }

  const total = counts.Adulto + counts.Bambino + counts.Disabilità + counts.Unico + counts.Sconosciuto;
  return { counts, total, used };
}

// ---------- Aggregazione per ordine×evento×data×slot ----------
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
  const customerName = order?.customer ? `${safeString(order.customer.first_name)} ${safeString(order.customer.last_name)}`.trim() : '';
  const customerEmail = safeString(order?.email || order?.contact_email);
  const currency = safeString(order.currency);
  const totalGross = Number(order.total_price ?? 0);
  const payGws = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names.join(',') : '';
  const orderTags = (order.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  // 0) se abbiamo il riepilogo nelle note, è la fonte primaria
  const notesEntries = getNoteSummaryEntries(order);
  if (notesEntries.length) {
    const eventGuess = guessEventFromOrder(order, orderTags);
    for (const e of notesEntries) {
      const date = e.date || '';
      const slot = e.slot || '';
      const key = [orderId, eventGuess, date, slot].join('||');

      if (!buckets.has(key)) {
        buckets.set(key, {
          createdAt, orderName, orderId, customerName, customerEmail,
          event: eventGuess, date, slot,
          counts: { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 },
          qtyTotal: 0,
          totalGross, currency, payGws, processedAt,
        });
      }
      const b = buckets.get(key)!;
      const sum = e.counts.Adulto + e.counts.Bambino + e.counts.Disabilità + e.counts.Unico + e.counts.Sconosciuto;
      b.qtyTotal += sum;
      b.counts.Adulto      += e.counts.Adulto;
      b.counts.Bambino     += e.counts.Bambino;
      b.counts.Disabilità  += e.counts.Disabilità;
      b.counts.Unico       += e.counts.Unico;
      b.counts.Sconosciuto += e.counts.Sconosciuto;
    }
  } else {
    // 1) altrimenti prova a leggere la tipologia dalle properties per ogni line item
    for (const li of lineItems) {
      if (li.gift_card === true) continue;

      const event = pickEventFrom(safeString(li.title), safeString(li.product_title), orderTags);
      const { date, slot } = extractDateSlot(li);

      const viaProps = countTypesFromProperties(li);
      if (!viaProps.used) {
        // 2) fallback: deduci dal titolo/sku/variant e conta la quantity
        const source = safeString(li.variant_title) || safeString(li.title) || safeString(li.sku);
        let t = normTicketType(source);
        if (t.toLowerCase().includes('handicap')) t = 'Disabilità';
        if (t === 'Sconosciuto') t = 'Unico';
        (viaProps.counts as any)[t] += Number(li.quantity || 0);
      }

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

      const addQty = viaProps.used ? (viaProps.total || Number(li.quantity || 0)) : Number(li.quantity || 0);
      b.qtyTotal += addQty;
      b.counts.Adulto      += viaProps.counts.Adulto;
      b.counts.Bambino     += viaProps.counts.Bambino;
      b.counts.Disabilità  += viaProps.counts.Disabilità;
      b.counts.Unico       += viaProps.counts.Unico;
      b.counts.Sconosciuto += viaProps.counts.Sconosciuto;
    }
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

// ---------- Next config ----------
export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
  },
};

// ---------- Handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const dryRun = String(req.query.dryRun || '') === '1';
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';

    const isWebhook = Boolean(req.headers['x-shopify-topic']);
    if (isWebhook) {
      if (!secret) return res.status(500).json({ ok: false, error: 'SHOPIFY_WEBHOOK_SECRET not set' });
      const ok = verifyShopifyHmac(req, secret);
      if (!ok) return res.status(401).json({ ok: false, error: 'Invalid HMAC' });
    }

    const order = req.body && req.body.id ? req.body : null;
    if (!order) return res.status(400).json({ ok: false, error: 'Invalid payload: expected order object' });

    const rows = collectRowsFromOrder(order);

    if (dryRun) {
      return res.status(200).json({ ok: true, dryRun: true, preview_rows: rows });
    }

    await appendRowsToSheet(rows);
    return res.status(200).json({ ok: true, appended: rows.length });
  } catch (err: any) {
    console.error('orders-to-sheets error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
}
