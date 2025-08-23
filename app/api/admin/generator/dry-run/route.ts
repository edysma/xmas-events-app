// app/api/admin/generator/dry-run/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const DEFAULT_LOCATION_ID = process.env.DEFAULT_LOCATION_ID || "";

// --- CORS & Auth ---
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

// --- Helpers ---
function isISODate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && s === `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
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
function hhmmCompact(t: string) {
  return t.replace(":", "");
}

// Tipi di ticket ammessi e seats_per_ticket
const TICKET_PRESETS: Record<string, Array<{ key: "single"|"adulto"|"bambino"|"handicap"; seats: 1|2 }>> = {
  single:  [{ key: "single",   seats: 1 }],
  triple:  [{ key: "adulto",   seats: 1 }, { key: "bambino", seats: 1 }, { key: "handicap", seats: 2 }],
};

type InputSlot =
  | { time: string; tickets?: "single"|"triple" }
  | { time: string; tickets: Array<{ key: "single"|"adulto"|"bambino"|"handicap"; seats?: 1|2 }> };

type Payload = {
  collection: string;           // handle della collection evento (es. "viaggio-incantato")
  date: string;                 // "YYYY-MM-DD"
  capacity: number;             // capienza SeatUnit per slot (es. 50)
  slots: InputSlot[];           // orari
  locationId?: string;          // opzionale, default = DEFAULT_LOCATION_ID
  namePrefix?: string;          // opzionale, prefisso per nomi prodotti (es. "Xmas 2025")
};

// Normalizzazione ticket
function normalizeTickets(tickets: InputSlot["tickets"]) {
  if (!tickets || tickets === "single") return TICKET_PRESETS.single;
  if (tickets === "triple") return TICKET_PRESETS.triple;
  const arr = Array.isArray(tickets) ? tickets : [];
  const seen = new Set<string>();
  const out: Array<{ key: "single"|"adulto"|"bambino"|"handicap"; seats: 1|2 }> = [];
  for (const t of arr) {
    if (!t?.key) continue;
    if (!["single","adulto","bambino","handicap"].includes(t.key)) continue;
    const seats = (t.key === "handicap") ? 2 : (t.seats === 1 || t.seats === 2 ? t.seats : 1);
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push({ key: t.key as any, seats: seats as 1|2 });
  }
  if (!out.length) return TICKET_PRESETS.single;
  return out;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return withCORS(NextResponse.json({ ok:false, error:"Unauthorized" }, { status: 401 }));
  }

  let body: Partial<Payload> = {};
  try {
    body = await req.json();
  } catch {
    return withCORS(NextResponse.json({ ok:false, error:"Invalid JSON body" }, { status: 400 }));
  }

  // --- Validazione minima ---
  const errors: string[] = [];
  if (!body.collection) errors.push("Missing 'collection' (collection handle).");
  if (!body.date || !isISODate(body.date)) errors.push("Missing or invalid 'date' (YYYY-MM-DD).");
  if (!Number.isFinite(body.capacity!) || (body.capacity as number) <= 0) errors.push("Missing or invalid 'capacity' (>0).");
  if (!Array.isArray(body.slots) || !body.slots.length) errors.push("Missing 'slots' (non-empty array).");
  const slots = (body.slots || []).map((s, idx) => {
    const time = (s as any)?.time;
    if (!time || !isTime(time)) {
      errors.push(`Slot[${idx}] invalid 'time' (expected HH:mm).`);
    }
    return {
      time,
      tickets: normalizeTickets((s as any)?.tickets),
    };
  });

  if (errors.length) {
    return withCORS(NextResponse.json({ ok:false, error:"validation_failed", details: errors }, { status: 422 }));
  }

  const collection = String(body.collection);
  const date = String(body.date);
  const capacity = Math.floor(Number(body.capacity));
  const locationId = body.locationId || DEFAULT_LOCATION_ID || null;
  const namePrefix = (body.namePrefix || "").trim();

  // --- Costruzione piano (dry-run, nessuna scrittura) ---
  // Convenzioni suggerite (personalizzabili nelle prossime iterazioni):
  // - SeatUnit: 1 variante per ciascuno slot orario dello stesso giorno
  //   Product title: `${namePrefix || collection} — ${date}`
  //   Variant title: `${time}`
  //   SKU variant (suggerito): `SU-${date}-${HHmm}`
  // - Bundle: 1 prodotto per slot, con fino a 3 varianti (adulto/bambino/handicap) oppure 1 variante "single"
  //   Product title: `${namePrefix || collection} — ${date} ${time}`
  //   Variant titles: capitalizzate (Adulto/Bambino/Handicap) o "Biglietto unico"
  //   Metafield variante:
  //     - sinflora.seat_unit = riferimento alla SeatUnit variant corrispondente
  //     - sinflora.seats_per_ticket = 1 (o 2 per Handicap)

  const plan = slots.map((sl) => {
    const compact = hhmmCompact(sl.time!);
    const baseTitle = `${namePrefix || collection} — ${date}`;
    const suProductTitle = baseTitle;
    const suVariantTitle = sl.time!;
    const suVariantSKU   = `SU-${date}-${compact}`;

    // Bundle
    const bundleProductTitle = `${namePrefix || collection} — ${date} ${sl.time}`;
    const bundleHandle = slugify(`${bundleProductTitle}`);

    const variants = sl.tickets.map(t => {
      const vTitle =
        t.key === "single" ? "Biglietto unico" :
        t.key === "adulto" ? "Adulto" :
        t.key === "bambino" ? "Bambino" :
        "Handicap";
      return {
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
        product: {
          title: suProductTitle,
          handle: slugify(suProductTitle),
          tags: ["SeatUnit"],
        },
        variant: {
          title: suVariantTitle,
          sku: suVariantSKU,
          inventory: {
            tracked: true,
            continueSelling: false,
            perLocation: locationId ? [{ locationId, available: capacity }] : [],
          },
        },
      },
      bundle: {
        product: {
          title: bundleProductTitle,
          handle: bundleHandle,
          tags: ["Bundle"],
        },
        variants,
      },
    };
  });

  const summary = {
    date,
    slots: plan.length,
    totalBundles: plan.length, // 1 prodotto bundle per slot
    totalBundleVariants: plan.reduce((sum, p) => sum + p.bundle.variants.length, 0),
    totalSeatUnitVariants: plan.length, // 1 variante SeatUnit per slot
  };

  return withCORS(NextResponse.json({
    ok: true,
    dryRun: true,
    input: { collection, date, capacity, locationId, namePrefix: namePrefix || null },
    summary,
    plan,
    note: "Questo è un dry-run: nessuna scrittura. Prossimo step: lookup esistenza su Shopify e poi creazione/aggiornamento.",
  }));
}
