// app/api/admin/generate-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getShopPublicHolidays } from "@/lib/shopify-admin";
import {
  ensureSeatUnit,
  ensureBundle,
  setVariantPrices,
  ensureVariantLeadsToSeat,
  ensureInventory, // <-- aggiunto
} from "@/lib/bundles";

import type {
  GenerateInput,
  ManualInput,
  PreviewItem,
  GenerateResponse,
  DayType,
  PriceTierEuro,
  PricesEuro,
} from "@/types/generate";

const TZ = "Europe/Rome";

// ---------------- utils date/day ----------------

function listDates(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  while (d.getTime() <= stop.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function weekdayRome(date: string): number {
  const name = new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    timeZone: TZ,
  })
    .format(new Date(date + "T12:00:00Z"))
    .toLowerCase();
  const map: Record<string, number> = {
    lun: 1,
    mar: 2,
    mer: 3,
    gio: 4,
    ven: 5,
    sab: 6,
    dom: 7,
  };
  return map[name] ?? 0;
}

function weekdayKey(date: string): "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" {
  const w = weekdayRome(date);
  switch (w) {
    case 1: return "mon";
    case 2: return "tue";
    case 3: return "wed";
    case 4: return "thu";
    case 5: return "fri";
    case 6: return "sat";
    case 7: return "sun";
    default: return "mon";
  }
}

function dayTypeOf(date: string, holidays: Set<string>): DayType {
  if (holidays.has(date)) return "holiday";
  const w = weekdayRome(date);
  if (w === 6) return "saturday";
  if (w === 7) return "sunday";
  if (w === 5) return "friday";
  return "weekday";
}

// ---------------- pricing helpers ----------------

function pickTierForDate(
  date: string,
  dt: DayType,
  prices: PricesEuro,
  fridayAsWeekend: boolean,
  exceptionsByDate?: Record<string, PriceTierEuro>
): PriceTierEuro | undefined {
  if (exceptionsByDate && exceptionsByDate[date]) return exceptionsByDate[date];

  if (dt === "holiday") return prices.holiday;
  if (dt === "saturday") return prices.saturday;
  if (dt === "sunday") return prices.sunday;

  if (dt === "friday") {
    if (fridayAsWeekend) {
      return prices.saturday ?? prices.sunday ?? prices.holiday ?? prices.feriali;
    }
    return prices.friday ?? prices.feriali;
  }

  const wk = weekdayKey(date);
  const perDay = prices.feriali?.perDay;
  if (perDay) {
    if (wk === "mon" && perDay.mon) return perDay.mon;
    if (wk === "tue" && perDay.tue) return perDay.tue;
    if (wk === "wed" && perDay.wed) return perDay.wed;
    if (wk === "thu" && perDay.thu) return perDay.thu;
  }
  return prices.feriali;
}

function decideMode(tier?: PriceTierEuro): "unico" | "triple" | undefined {
  if (!tier) return undefined;
  if (typeof tier.unico === "number") return "unico";
  if (typeof tier.adulto === "number" || typeof tier.bambino === "number" || typeof tier.handicap === "number") {
    return "triple";
  }
  return undefined;
}

// ---------------- route ----------------
async function previewFromFeed(req: NextRequest, body: any) {
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host")}`;

  const u = new URL("/api/admin/events-feed-bundles", origin);
  u.searchParams.set("month", body.month);
  u.searchParams.set("collection", body.collection);
  u.searchParams.set("source", body.source ?? "manual");

  const res = await fetch(u.toString(), {
    headers: {
      "x-admin-secret": req.headers.get("x-admin-secret") || "",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`feed error: ${res.status} ${t}`);
  }
  const feed = await res.json();

  // Normalizza in preview minimale
  const preview = [];
  const warnings: string[] = [];
  if (Array.isArray(feed?.events)) {
    for (const d of feed.events) {
      const date = String(d?.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        warnings.push(`Giorno ignorato: date non valida "${d?.date}"`);
        continue;
      }
      const slots = Array.isArray(d?.slots) ? d.slots : [];
      for (const s of slots) {
        const time = String(s?.time || "").slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(time)) {
          warnings.push(`Slot ignorato: time non valido "${s?.time}" (${date})`);
          continue;
        }
        const dayType = s?.day_type || s?.dayType || null;

        // Mappa le tre tipologie se presenti
        const rows = [
          { type: "Adulto",   gid: s?.bundleVariantId_adulto },
          { type: "Bambino",  gid: s?.bundleVariantId_bambino },
          { type: "Handicap", gid: s?.bundleVariantId_handicap },
        ];
        let pushed = 0;
        for (const r of rows) {
          if (r.gid) {
            preview.push({
              date,
              time,
              dayType,
              type: r.type,
              bundleVariantIdGid: r.gid,
            });
            pushed++;
          }
        }
        if (!pushed) {
          preview.push({
            date,
            time,
            dayType,
            type: "Biglietto unico",
          });
        }
      }
    }
  } else {
    warnings.push("Feed vuoto o in formato inatteso.");
  }

  return NextResponse.json(
    {
      ok: true,
      summary: { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 },
      preview,
      warnings,
    },
    { status: 200 }
  );
}


export async function POST(req: NextRequest) {
  try {
    const secret = req.headers.get("x-admin-secret");
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    let body: GenerateInput & {
      dryRun?: boolean;
      templateSuffix?: string;
      tags?: string[];
      description?: string;
      imageUrl?: string;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }

    // Supporto feed preview: se arrivano month+collection → anteprima dal feed (nessuna creazione)
if (body?.month && body?.collection) {
  return await previewFromFeed(req, body);
}

// Altrimenti accettiamo solo source:"manual" (comportamento esistente)
if (body.source !== "manual") {
  return NextResponse.json(
    { ok: false, error: "source_not_supported_yet", detail: 'Usa {"source":"manual"} oppure passa month+collection per il preview da feed' },
    { status: 400 }
  );
}


    const input = body as ManualInput & {
      dryRun?: boolean;
      templateSuffix?: string;
      tags?: string[];
      description?: string;
      imageUrl?: string;
    };
    const dryRun = input.dryRun !== false; // default true

    const templateSuffix = input.templateSuffix;
    const tags = input.tags;
    const description = input.description;
    const imageUrl = input.imageUrl;

    const holidaysArr = await getShopPublicHolidays();
    const holidays = new Set(holidaysArr);

    const dates = listDates(input.startDate, input.endDate);
    const preview: PreviewItem[] = [];
    const warningsGlobal: string[] = [];

    // Nota: per ora i contatori "created" rimangono 0 (riempiremo in seguito se serve)
    let seatsCreated = 0;
    let bundlesCreated = 0;
    let variantsCreated = 0;

    for (const date of dates) {
      const dt = dayTypeOf(date, holidays);

      const useWeekendSlots =
        dt === "saturday" || dt === "sunday" || dt === "holiday" || (dt === "friday" && input.fridayAsWeekend);
      const slots = useWeekendSlots ? input.weekendSlots : input.weekdaySlots;

      const tier = pickTierForDate(date, dt, input["prices€"], input.fridayAsWeekend, input.exceptionsByDate);
      const mode = decideMode(tier);

      for (const time of slots) {
        const item: PreviewItem = {
          date,
          time,
          dayType: dt,
          "pricePlan€": tier,
          mode: mode as any,
        };

        if (!tier || !mode) {
          item.warnings = item.warnings ?? [];
          if (!tier) item.warnings.push("Nessun listino prezzi per questo slot");
          if (!mode) item.warnings.push("Definisci 'unico' o almeno una tra adulto/bambino/handicap");
          if (preview.length < 10) preview.push(item);
          continue;
        }

        // ---------- Seat Unit ----------
const seat = await ensureSeatUnit({
  date,
  time,
  titleBase: input.eventHandle,
  tags,
  description,
  templateSuffix,
  dryRun,
});
// incrementa contatori (solo se non è dryRun e se creato ora)
if (!dryRun && seat.created) seatsCreated++;


        // stock iniziale
        await ensureInventory({
          variantId: seat.variantId,
          locationId: input.locationId,
          quantity: input.capacityPerSlot,
          dryRun,
        });

       // ---------- Bundle ----------
const bundle = await ensureBundle({
  eventHandle: input.eventHandle,
  date,
  time,
  titleBase: input.eventHandle,
  templateSuffix,
  tags,
  description,
  dayType: dt,
  mode,
  "priceTier€": tier,
  dryRun,
});
// incrementa contatori (solo se non è dryRun)
if (!dryRun) {
  if (bundle.createdProduct) bundlesCreated++;
  if (typeof bundle.createdVariants === "number") {
    variantsCreated += bundle.createdVariants;
  }
}


        // ---------- Componenti (collega variante seat) ----------
        // qty 1 per tutte, tranne handicap = 2
        const compOps: (["unico" | "adulto" | "bambino" | "handicap", number])[] =
          mode === "unico"
            ? [["unico", 1]]
            : [["adulto", 1], ["bambino", 1], ["handicap", 2]];

        if (!dryRun) {
          for (const [k, qty] of compOps) {
            const parentVariantId = bundle.variantMap[k];
            if (!parentVariantId) continue;
            await ensureVariantLeadsToSeat({
  bundleVariantId: parentVariantId,
  seatVariantId: seat.variantId,
  componentQuantity: qty,
  dryRun: input.dryRun,
});

          }
        }

        // ---------- Prezzi ----------
        if (!dryRun) {
          const pricesToSet: Record<string, number | undefined> = {};
          if (mode === "unico") {
            const vid = bundle.variantMap.unico;
            if (vid && typeof tier.unico === "number") pricesToSet[vid] = tier.unico;
          } else {
            const { adulto, bambino, handicap } = bundle.variantMap;
            if (adulto && typeof tier.adulto === "number") pricesToSet[adulto] = tier.adulto;
            if (bambino && typeof tier.bambino === "number") pricesToSet[bambino] = tier.bambino;
            if (handicap && typeof tier.handicap === "number") pricesToSet[handicap] = tier.handicap;
          }
         if (Object.keys(pricesToSet).length) {
  await setVariantPrices(bundle.productId, pricesToSet);
}
        }

        // ---------- Preview ----------
        if (preview.length < 10) {
          item.seatProductId = seat.productId;
          item.bundleProductId = bundle.productId;
          item.variantMap = {
            unico: bundle.variantMap.unico,
            adulto: bundle.variantMap.adulto,
            bambino: bundle.variantMap.bambino,
            handicap: bundle.variantMap.handicap,
          };
          preview.push(item);
        }
      }
    }

    const resp: GenerateResponse = {
      ok: true,
      summary: { seatsCreated, bundlesCreated, variantsCreated },
      preview,
      warnings: warningsGlobal,
    };
    return NextResponse.json(resp, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "internal_error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}
