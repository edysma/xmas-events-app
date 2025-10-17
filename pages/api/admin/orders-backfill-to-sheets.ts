// pages/api/admin/orders-backfill-to-sheets.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { google } from 'googleapis';

// === Config ===
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const API_VERSION = '2023-10'; // ok per backfill

// === Tipi ===
type Counts = { Adulto: number; Bambino: number; Disabilità: number; Unico: number; Sconosciuto: number };

// === Google Sheets client (normalizza la private key) ===
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

// === Helpers comuni ===
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

// === Nuovo: conteggio tipi robusto dalle PROPERTIES ===
function countTypesFromProperties(li: any): { counts: Counts; total: number; used: boolean } {
  const counts: Counts = { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 };
  let used = false;

  const props = Array.isArray(li.properties) ? li.properties : [];
  const entries = props.map((p: any) => ({
    k: String(p?.name ?? '').toLowerCase().trim(),
    v: String(p?.value ?? '').toLowerCase().trim(),
    rawV: String(p?.value ?? ''),
  }));

  const inc = (label: keyof Counts, n = 1) => { (counts as any)[label] += n; used = true; };

  const keyHas = (k: string, frag: RegExp) => frag.test(k);
  const valHas = (v: string, frag: RegExp) => frag.test(v);

  const R_ADULTO = /adult/;
  const R_BAMBINO = /(bambin|child|kid)/;
  const R_DISAB = /(disab|handicap|invalid)/;
  const R_UNICO = /(unico|unique|singol)/;
  const R_TIPO_FIELD = /(tipo|tipologia|tariffa|ticket|categoria|bigliett)/;

  for (const { k, v, rawV } of entries) {
    // 1) Se il VALORE contiene adulto/bambino/... -> +1 per persona
    if (valHas(v, R_ADULTO)) { inc('Adulto'); continue; }
    if (valHas(v, R_BAMBINO)) { inc('Bambino'); continue; }
    if (valHas(v, R_DISAB)) { inc('Disabilità'); continue; }
    if (valHas(v, R_UNICO)) { inc('Unico'); continue; }

    // 2) Se il NOME contiene adulto/bambino/... usa numero nel valore (o bool=1)
    if (keyHas(k, R_ADULTO)) {
      const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (v === 'true' || v === 'si' || v === 'sì' || v === 'yes' ? 1 : 0);
      if (n > 0) inc('Adulto', n); continue;
    }
    if (keyHas(k, R_BAMBINO)) {
      const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (v === 'true' || v === 'si' || v === 'sì' || v === 'yes' ? 1 : 0);
      if (n > 0) inc('Bambino', n); continue;
    }
    if (keyHas(k, R_DISAB)) {
      const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (v === 'true' || v === 'si' || v === 'sì' || v === 'yes' ? 1 : 0);
      if (n > 0) inc('Disabilità', n); continue;
    }
    if (keyHas(k, R_UNICO)) {
      const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (v === 'true' || v === 'si' || v === 'sì' || v === 'yes' ? 1 : 0);
      if (n > 0) inc('Unico', n); continue;
    }

    // 3) Campi "Tipo/Tipologia/Ticket/..." (anche "Tipo 1", "Tipologia 2", "Tipo biglietto 1")
    if (keyHas(k, R_TIPO_FIELD) && v) {
      let t = 'Sconosciuto';
      if (R_ADULTO.test(v)) t = 'Adulto';
      else if (R_BAMBINO.test(v)) t = 'Bambino';
      else if (R_DISAB.test(v)) t = 'Disabilità';
      else if (R_UNICO.test(v)) t = 'Unico';
      inc(t as keyof Counts);
      continue;
    }

    // 4) Ultima spiaggia: se valore è un numero e il nome contiene "persone" o "qty", mettilo in Unico
    if (/\d+/.test(v) && /(persone|persona|qty|quantita|quantità|pezzi)/.test(k)) {
      const n = parseInt(v.match(/\d+/)![0], 10);
      if (n > 0) inc('Unico', n);
    }
  }

  const total = counts.Adulto + counts.Bambino + counts.Disabilità + counts.Unico + counts.Sconosciuto;
  return { counts, total, used };
}

// === Trasforma un ordine in righe aggregate ===
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

  for (const li of lineItems) {
    if (li.gift_card === true) continue;

    const event = pickEventFrom(safeString(li.title), safeString(li.product_title), orderTags);
    const { date, slot } = extractDateSlot(li);

    // 1) Prova a contare dalle properties (per-persona o numeriche)
    const viaProps = countTypesFromProperties(li);

    // 2) Se nada nelle properties, usa variante/titolo/SKU * quantity
    if (!viaProps.used) {
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
      totalGross, currency, payGws, processedAt,
    ]);
  }
  return rows;
}

// === Utils backfill ===
function asUTCStart(dateStr: string) { return `${dateStr}T00:00:00Z`; }
function asUTCEnd(dateStr: string)   { return `${dateStr}T23:59:59Z`; }

async function fetchOrdersInRange(minISO: string, maxISO: string) {
  const shop = process.env.SHOP_DOMAIN!;
  const token = process.env.ADMIN_ACCESS_TOKEN!;
  const base = `https://${shop}/admin/api/${API_VERSION}/orders.json`;

  const orders: any[] = [];
  // campi essenziali (line_items contiene title, variant_title, sku, properties, quantity)
  let nextUrl = `${base}?status=any&limit=250&created_at_min=${encodeURIComponent(minISO)}&created_at_max=${encodeURIComponent(maxISO)}&order=created_at+asc&fields=id,name,created_at,processed_at,email,tags,financial_status,fulfillment_status,customer,currency,total_price,payment_gateway_names,line_items`;

  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Shopify ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    orders.push(...(data.orders || []));

    // Pagination via Link header (rel="next")
    const link = resp.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/i);
    nextUrl = m ? m[1] : '';
  }

  return orders;
}

// === Handler ===
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const adminSecret = process.env.ADMIN_SECRET || '';
    const q = req.query as any;

    // Sicurezza semplice: secret nel querystring o header
    const provided = (q.secret as string) || (req.headers['x-admin-secret'] as string);
    if (!adminSecret || provided !== adminSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized (secret mancante o errato)' });
    }

    const since = String(q.since || '').trim(); // YYYY-MM-DD (obbligatorio)
    const until = String(q.until || '').trim() || new Date().toISOString().slice(0,10); // YYYY-MM-DD (default: oggi)
    const dryRun = String(q.dryRun || '') === '1';

    if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({ ok: false, error: 'Parametro "since" richiesto. Formato: YYYY-MM-DD' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ ok: false, error: 'Parametro "until" non valido. Formato: YYYY-MM-DD' });
    }

    const minISO = asUTCStart(since);
    const maxISO = asUTCEnd(until);

    // 1) Scarica ordini
    const orders = await fetchOrdersInRange(minISO, maxISO);

    // 2) Trasforma -> righe
    const rowsAll: any[][] = [];
    for (const order of orders) {
      const rows = collectRowsFromOrder(order);
      rowsAll.push(...rows);
    }

    // 3) Se dryRun: non scrive, mostra anteprima
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        since,
        until,
        orders_count: orders.length,
        rows_count: rowsAll.length,
        sample_rows: rowsAll.slice(0, 5),
      });
    }

    // 4) Scrive su Sheets in batch
    const BATCH = 500;
    for (let i = 0; i < rowsAll.length; i += BATCH) {
      await appendRowsToSheet(rowsAll.slice(i, i + BATCH));
    }

    return res.status(200).json({
      ok: true,
      since,
      until,
      orders_count: orders.length,
      rows_written: rowsAll.length,
    });
  } catch (err: any) {
    console.error('backfill error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
}
