// app/api/admin/generator/plan/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const DEFAULT_LOCATION_ID = process.env.DEFAULT_LOCATION_ID || "";

/* -------------------- CORS & AUTH -------------------- */
function withCORS(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret, Authorization");
  res.headers.append("Vary", "Origin");
  return res;
}
export function OPTIONS() {
  return withCORS(new NextResponse(null, { status: 204 }));
}
function isAuthorized(req: NextRequest) {
  const header = req.headers.get("x-admin-secret")
    || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!ADMIN_SECRET && header === ADMIN_SECRET;
}

/* -------------------- Helpers di validazione -------------------- */
function isISODate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) &&
    s === `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}
function isTime(s: string) {
  if (!/^\d{2}:\d{2}$/.test(s)) return false;
  const [H,M] = s.split(":").map(Number);
  return H>=0 && H<=23 && M>=0 && M<=59;
}
function slugify(s: string) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
function hhmmCompact(t: string) { return t.replace(":", ""); }

/* -------------------- Preset ticket -------------------- */
type TicketKey = "single"|"adulto"|"bambino"|"handicap";
const TICKET_PRESETS: Record<string, Array<{ key: TicketKey; seats: 1|2 }>> = {
  single: [{ key: "single", seats: 1 }],
  triple: [{ key: "adulto", seats: 1 }, { key: "bambino", seats: 1 }, { key: "handicap", seats: 2 }],
};

type InputSlot =
  | { time: string; tickets?: "single"|"triple" }
  | { time: string; tickets: Array<{ key: TicketKey; seats?: 1|2 }> };

type Payload = {
  collection: string;
  date: string;
  capacity: number;
  slots: InputSlot[];
  locationId?: string;
  namePrefix?: string;
};

function normalizeTickets(tickets: InputSlot["tickets"]) {
  if (!tickets || tickets === "single") return TICKET_PRESETS.single;
  if (tickets === "triple") return TICKET_PRESETS.triple;
  const arr = Array.isArray(tickets) ? tickets : [];
  const seen = new Set<string>();
  const out: Array<{ key: TicketKey; seats: 1|2 }> = [];
  for (const t of arr) {
    if (!t?.key) continue;
    if (!["single","adulto","bambino","handicap"].includes(t.key)) continue;
    const seats = (t.key === "handicap") ? 2 : (t.seats === 1 || t.seats === 2 ? t.seats : 1);
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push({ key: t.key as TicketKey, seats: seats as 1|2 });
  }
  return out.length ? out : TICKET_PRESETS.single;
}

/* -------------------- GQL -------------------- */
const QUERY_PRODUCT_BY_HANDLE = /* GraphQL */ `
  query ProductLookup($handle: String!, $title: String!, $tag: String!) {
    productByHandle(handle: $handle) {
      id title handle
      tags
      variants(first: 100) { nodes { id title sku } }
    }
    products(first: 1, query: $title) {
      edges { node {
        id title handle tags
        variants(first: 100) { nodes { id title sku } }
      } }
    }
    # Ricerca alternativa per tag + titolo (migliora affidabilità)
    productsByTag: products(first: 1, query: $tag) {
      edges { node {
        id title handle tags
        variants(first: 100) { nodes { id title sku } }
      } }
    }
  }
`;

type VariantNode = { id: string; title: string; sku: string | null };
type ProductNode = { id: string; title: string; handle: string; tags: string[]; variants: { nodes: VariantNode[] } };

async function fetchProductWithFallback(handle: string, title: string, tag: string) {
  const data = await adminFetchGQL<{
    productByHandle: ProductNode | null;
    products: { edges: { node: ProductNode }[] };
    productsByTag: { edges: { node: ProductNode }[] };
  }>(QUERY_PRODUCT_BY_HANDLE, { handle, title: `title:'${title.replace(/'/g,"\\'")}'`, tag: `tag:${tag} AND title:'${title.replace(/'/g,"\\'")}'` });

  const byHandle = data?.productByHandle || null;
  const byTitle  = data?.products?.edges?.[0]?.node || null;
  const byTag    = data?.productsByTag?.edges?.[0]?.node || null;

  // Ordine preferenza: handle → tag+title → title
  const pick = byHandle || byTag || byTitle || null;
  return pick;
}

function findVariantId(prod: ProductNode, desiredTitle: string, desiredSKU?: string | null) {
  const nodes = prod?.variants?.nodes || [];
  // 1) match per SKU
  if (desiredSKU) {
    const v = nodes.find(n => (n.sku||"").trim() === desiredSKU);
    if (v) return { id: v.id, by: "sku" as const };
  }
  // 2) match per titolo (case sensitive come in Shopify)
  const v2 = nodes.find(n => n.title === desiredTitle);
  if (v2) return { id: v2.id, by: "title" as const };
  return null;
}

/* -------------------- Handler -------------------- */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return withCORS(NextResponse.json({ ok:false, error:"Unauthorized" }, { status: 401 }));
  }

  let body: Partial<Payload> = {};
  try { body = await req.json(); }
  catch { return withCORS(NextResponse.json({ ok:false, error:"Invalid JSON body" }, { status: 400 })); }

  // Validazione minima
  const errors: string[] = [];
  if (!body.collection) errors.push("Missing 'collection'.");
  if (!body.date || !isISODate(body.date)) errors.push("Missing or invalid 'date' (YYYY-MM-DD).");
  if (!Number.isFinite(body.capacity!) || (body.capacity as number) <= 0) errors.push("Missing or invalid 'capacity' (>0).");
  if (!Array.isArray(body.slots) || !body.slots.length) errors.push("Missing 'slots' (non-empty array).");

  const normSlots = (body.slots || []).map((s, idx) => {
    const time = (s as any)?.time;
    if (!time || !isTime(time)) {
      errors.push(`Slot[${idx}] invalid 'time' (HH:mm).`);
    }
    return { time, tickets: normalizeTickets((s as any)?.tickets) };
  });

  if (errors.length) {
    return withCORS(NextResponse.json({ ok:false, error:"validation_failed", details: errors }, { status: 422 }));
  }

  const collection = String(body.collection);
  const date = String(body.date);
  const capacity = Math.floor(Number(body.capacity));
  const locationId = body.locationId || DEFAULT_LOCATION_ID || null;
  const namePrefix = (body.namePrefix || "").trim();

  // Costruzione piano base (come dry-run precedente)
  const plan = normSlots.map((sl) => {
    const compact = hhmmCompact(sl.time!);
    const baseTitle = `${namePrefix || collection} — ${date}`;
    const suProductTitle = baseTitle;
    const suVariantTitle = sl.time!;
    const suVariantSKU   = `SU-${date}-${compact}`;

    const bundleProductTitle = `${namePrefix || collection} — ${date} ${sl.time}`;
    const bundleHandle = slugify(`${bundleProductTitle}`);

    const variants = sl.tickets.map(t => {
      const vTitle =
        t.key === "single" ? "Biglietto unico" :
        t.key === "adulto" ? "Adulto" :
        t.key === "bambino" ? "Bambino" : "Handicap";
      return {
        key: t.key,
        title: vTitle,
        seats_per_ticket: t.seats,
        metafields: [
          { namespace: "sinflora", key: "seat_unit", type: "product_variant_reference", value: "<to-fill: seatUnitVariantGID>" },
          { namespace: "sinflora", key: "seats_per_ticket", type: "number_integer", value: String(t.seats) },
        ],
      };
    });

    return {
      date,
      time: sl.time,
      capacity,
      locationId,
      seatUnit: {
        product: { title: suProductTitle, handle: slugify(suProductTitle), tags: ["SeatUnit"] },
        variant: { title: suVariantTitle, sku: suVariantSKU,
          inventory: { tracked: true, continueSelling: false, perLocation: locationId ? [{ locationId, available: capacity }] : [] } },
      },
      bundle: {
        product: { title: bundleProductTitle, handle: bundleHandle, tags: ["Bundle"] },
        variants,
      },
    };
  });

  // -------- Lookup su Shopify (senza scrivere) --------
  const lookups: Array<{
    slot: string;
    seatUnit: { productHandle: string; productId: string|null; variantId: string|null; matchedBy?: "sku"|"title"|null };
    bundle: { productHandle: string; productId: string|null; variants: Array<{ title: string; id: string|null }> };
  }> = [];

  for (const p of plan) {
    // SeatUnit product (stesso titolo per tutti gli slot del giorno)
    const suHandle = p.seatUnit.product.handle;
    const suTitle  = p.seatUnit.product.title;
    const suProd = await fetchProductWithFallback(suHandle, suTitle, "SeatUnit");
    let suVarId: string|null = null;
    let suMatchBy: "sku"|"title"|null = null;
    if (suProd) {
      const found = findVariantId(suProd, p.seatUnit.variant.title, p.seatUnit.variant.sku);
      suVarId = found?.id || null;
      suMatchBy = found?.by || null;
    }

    // Bundle product
    const bHandle = p.bundle.product.handle;
    const bTitle  = p.bundle.product.title;
    const bProd = await fetchProductWithFallback(bHandle, bTitle, "Bundle");

    const bVarStatuses: Array<{ title: string; id: string|null }> = [];
    if (bProd) {
      for (const v of p.bundle.variants) {
        const found = findVariantId(bProd, v.title, null); // per bundle titoli sono univoci
        bVarStatuses.push({ title: v.title, id: found?.id || null });
      }
    } else {
      for (const v of p.bundle.variants) bVarStatuses.push({ title: v.title, id: null });
    }

    lookups.push({
      slot: `${p.date} ${p.time}`,
      seatUnit: { productHandle: suHandle, productId: suProd?.id || null, variantId: suVarId, matchedBy: suMatchBy || null },
      bundle:   { productHandle: bHandle, productId: bProd?.id || null, variants: bVarStatuses },
    });
  }

  // Suggerimento azioni (non esegue nulla)
  const actions = lookups.map((l, i) => {
    const p = plan[i];
    const seatUnitActions = [];
    if (!l.seatUnit.productId) seatUnitActions.push("create_product");
    if (!l.seatUnit.variantId) seatUnitActions.push("ensure_variant");
    const bundleActions = [];
    if (!l.bundle.productId) bundleActions.push("create_product");
    const missingVars = l.bundle.variants.filter(v => !v.id).map(v => v.title);
    if (missingVars.length) bundleActions.push(`ensure_variants: ${missingVars.join(", ")}`);
    return {
      slot: l.slot,
      seatUnit: seatUnitActions,
      bundle: bundleActions,
    };
  });

  return withCORS(NextResponse.json({
    ok: true,
    dryRun: true,
    summary: {
      date,
      slots: plan.length,
      totalBundles: plan.length,
      totalBundleVariants: plan.reduce((s,p)=>s+p.bundle.variants.length, 0),
      totalSeatUnitVariants: plan.length,
    },
    plan,
    lookup: lookups,
    suggestedActions: actions,
    note: "Solo lookup: nessuna scrittura. Step successivo: endpoint 'apply' che crea/aggiorna realmente.",
  }));
}
