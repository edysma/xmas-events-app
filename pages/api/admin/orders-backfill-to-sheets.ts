// pages/api/admin/orders-backfill-to-sheets.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { google } from 'googleapis';

// === Config ===
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const API_VERSION = '2024-10';

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

// === Conteggio tipi dalle PROPERTIES (nuovi ordini) ===
function countTypesFromProperties(li: any): { counts: Counts; total: number; used: boolean } {
  const counts: Counts = { Adulto: 0, Bambino: 0, Disabilità: 0, Unico: 0, Sconosciuto: 0 };
  let used = false;

  const props = Array.isArray(li.properties) ? li.properties : [];
  const entries = props.map((p: any) => ({
    k: String(p?.name ?? '').toLowerCase().trim(),
    v: String(p?.value ?? '').toLowerCase().trim(),
  }));

  const inc = (label: keyof Counts, n = 1) => { (counts as any)[label] += n; used = true; };

  const keyHas = (k: string, frag: RegExp) => frag.test(k);
  const valHas = (v: string, frag: RegExp) => frag.test(v);

  const R_ADULTO = /adult/;
  const R_BAMBINO = /(bambin|child|kid)/;
  const R_DISAB = /(disab|handicap|invalid)/;
  const R_UNICO = /(unico|unique|singol)/;
  const R_TIPO_FIELD = /(tipo|tipologia|tariffa|ticket|categoria|bigliett|ingresso|label)/;

  for (const { k, v } of entries) {
    if (valHas(v, R_ADULTO)) { inc('Adulto'); continue; }
    if (valHas(v, R_BAMBINO)) { inc('Bambino'); continue; }
    if (valHas(v, R_DISAB)) { inc('Disabilità'); continue; }
    if (valHas(v, R_UNICO)) { inc('Unico'); continue; }

    if (keyHas(k, R_ADULTO)) { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Adulto', n); continue; }
    if (keyHas(k, R_BAMBINO)) { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Bambino', n); continue; }
    if (keyHas(k, R_DISAB)) { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Disabilità', n); continue; }
    if (keyHas(k, R_UNICO)) { const m = v.match(/\d+/); const n = m ? parseInt(m[0], 10) : (/(true|si|sì|yes)/.test(v) ? 1 : 0); if (n > 0) inc('Unico', n); continue; }

    if (keyHas(k, R_TIPO_FIELD) && v) {
      let t = 'Sconosciuto';
      if (R_ADULTO.test(v)) t = 'Adulto';
      else if (R_BAMBINO.test(v)) t = 'Bambino';
      else if (R_DISAB.test(v)) t = 'Disabilità';
      else if (R_UNICO.test(v)) t = 'Unico';
      inc(t as keyof Counts);
      continue;
    }
  }

  const total = counts.Adulto + counts.Bambino + counts.Disabilità + counts.Unico + counts.Sconosciuto;
  return { counts, total, used };
}

// === Parser del riepilogo in note_attributes["_Riepilogo biglietti"] ===
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

// === Nome+Email con fallback (customer -> billing -> shipping) ===
function getCustomerName(order: any) {
  const fromCustomer = order?.customer ? `${safeString(order.customer.first_name)} ${safeString(order.customer.last_name)}`.trim() : '';
  if (fromCustomer) return fromCustomer;

  const b = order?.billing_address;
  if (b && (b.first_name || b.last_name)) return `${safeString(b.first_name)} ${safeString(b.last_name)}`.trim();

  const s = order?.shipping_address;
  if (s && (s.first_name || s.last_name)) return `${safeString(s.first_name)} ${safeString(s.last_name)}`.trim();

  return '';
}
function getCustomerEmail(order: any) {
  return safeString(order?.email || order?.contact_email || order?.customer?.email || '');
}

// == FETCH
function asUTCStart(dateStr: string) { return `${dateStr}T00:00:00Z`; }
function asUTCEnd(dateStr: string)   { return `${dateStr}T23:59:59Z`; }

async function fetchOrdersInRange(minISO: string, maxISO: string) {
  const shop = process.env.SHOP_DOMAIN!;
  const token = process.env.ADMIN_ACCESS_TOKEN!;
  const base = `https://${shop}/admin/api/${API_VERSION}/orders.json`;
  const orders: any[] = [];
  // includiamo anche PII (verrà vuoto se lo store non ha l'accesso PII)
  let nextUrl =
    `${base}?status=any&limit=250` +
    `&created_at_min=${encodeURIComponent(minISO)}` +
    `&created_at_max=${encodeURIComponent(maxISO)}` +
    `&order=created_at+asc` +
    `&fields=id,name,created_at,processed_at,email,contact_email,tags,financial_status,fulfillment_status,customer,` +
    `shipping_address,billing_address,` +
    `currency,total_price,payment_gateway_names,note_attributes,line_items`;
  while (nextUrl) {
    const resp = await fetch(nextUrl, { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }});
    if (!resp.ok) { const text = await resp.text(); throw new Error(`Shopify ${resp.status}: ${text}`); }
    const data = await resp.json();
    orders.push(...(data.orders || []));
    const link = resp.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/i);
    nextUrl = m ? m[1] : '';
  }
  return orders;
}

// === Trasforma un ordine in righe aggregate (usa summary note se presente) ===
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
  const customerName = getCustomerName(order);
  const customerEmail = getCustomerEmail(order);
  const currency = safeString(order.currency);
  const totalGross = Number(order.total_price ?? 0);
  const payGws = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names.join(',') : '';

  const orderTags = (order.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  // 0) Riepilogo in note = fonte primaria
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
    // 1) Altrimenti properties -> fallback titolo/SKU
    for (const li of lineItems) {
      if (li.gift_card === true) continue;

      const event = pickEventFrom(safeString(li.title), safeString(li.product_title), orderTags);
      const { date, slot } = extractDateSlot(li);

      const viaProps = countTypesFromProperties(li);
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

// === Handler ===
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const adminSecret = process.env.ADMIN_SECRET || '';
    const q = req.query as any;

    const provided = (q.secret as string) || (req.headers['x-admin-secret'] as string);
    if (!adminSecret || provided !== adminSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized (secret mancante o errato)' });
    }

    const since = String(q.since || '').trim();
    const until = String(q.until || '').trim() || new Date().toISOString().slice(0,10);
    const dryRun = String(q.dryRun || '') === '1';
    const debug = String(q.debug || '').toLowerCase();
    const filterOrderName = String(q.orderName || '');

    if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({ ok: false, error: 'Parametro "since" richiesto. Formato: YYYY-MM-DD' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ ok: false, error: 'Parametro "until" non valido. Formato: YYYY-MM-DD' });
    }

    const minISO = asUTCStart(since);
    const maxISO = asUTCEnd(until);

    // 1) Scarica ordini (con customer/billing/shipping/email)
    let orders = await fetchOrdersInRange(minISO, maxISO);
    if (filterOrderName) orders = orders.filter((o: any) => String(o.name) === filterOrderName);

    // Diagnostica: chi è stato popolato e da dove
    if (debug === 'who') {
      const who = orders.map((o: any) => {
        const fromCustomer = o?.customer && (o.customer.first_name || o.customer.last_name);
        const fromBilling = o?.billing_address && (o.billing_address.first_name || o.billing_address.last_name);
        const fromShipping = o?.shipping_address && (o.shipping_address.first_name || o.shipping_address.last_name);
        return {
          orderName: o.name,
          has_customer_obj: Boolean(fromCustomer),
          has_billing_name: Boolean(fromBilling),
          has_shipping_name: Boolean(fromShipping),
          email_sources: {
            order_email: Boolean(o?.email),
            contact_email: Boolean(o?.contact_email),
            customer_email: Boolean(o?.customer?.email),
          },
          resolved_name: getCustomerName(o),
          resolved_email: getCustomerEmail(o),
        };
      });
      return res.status(200).json({ ok: true, debug: 'who', since, until, orders_count: orders.length, who: who.slice(0, 25) });
    }

    // 2) Trasforma -> righe
    const rowsAll: any[][] = [];
    for (const order of orders) rowsAll.push(...collectRowsFromOrder(order));

    // 3) dryRun o scrittura
    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun: true, since, until,
        orders_count: orders.length,
        rows_count: rowsAll.length,
        sample_rows: rowsAll.slice(0, 5),
      });
    }

    const BATCH = 500;
    for (let i = 0; i < rowsAll.length; i += BATCH) {
      await appendRowsToSheet(rowsAll.slice(i, i + BATCH));
    }

    return res.status(200).json({ ok: true, since, until, orders_count: orders.length, rows_written: rowsAll.length });
  } catch (err: any) {
    console.error('backfill error', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
}
