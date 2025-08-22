// app/api/admin/generate-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL, getShopPublicHolidays } from "@/lib/shopify-admin";
import {
  ensureSeatUnit,
  ensureBundle,
  setVariantPrices,
  ensureVariantLeadsToSeat,
  ensureInventory,
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

/* ---------------- utils date/day ---------------- */

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
    lun: 1, mar: 2, mer: 3, gio: 4, ven: 5, sab: 6, dom: 7,
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

/* ---------------- pricing helpers ---------------- */

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

/* ---------------- helpers: PUBLISH + STATUS ---------------- */

const M_PRODUCT_UPDATE_STATUS = /* GraphQL */ `
  mutation ProductUpdateStatus($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

const M_PUBLISHABLE_PUBLISH = /* GraphQL */ `
  mutation PublishablePublish($id: ID!, $publicationId: ID!) {
    publishablePublish(id: $id, input: { publicationId: $publicationId }) {
      publishable {
        ... on Product {
          id
        }
      }
      userErrors { field message }
    }
  }
`;

async function setProductActive(productId: string) {
  const r = await adminFetchGQL(M_PRODUCT_UPDATE_STATUS, { input: { id: productId, status: "ACTIVE" } });
  const errs = (r as any)?.productUpdate?.userErrors || [];
  if (errs.length) throw new Error(`productUpdate (ACTIVE) error: ${errs.map((e: any) => e.message).join(" | ")}`);
}

async function publishProductToOnlineStore(productId: string) {
  const pubId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID;
  if (!pubId) return; // niente pubblicazione se non configurato
  const r = await adminFetchGQL(M_PUBLISHABLE_PUBLISH, { id: productId, publicationId: pubId });
  const errs = (r as any)?.publishablePublish?.userErrors || [];
  if (errs.length) throw new Error(`publishablePublish error: ${errs.map((e: any) => e.message).join(" | ")}`);
}

/* ---------------- helpers: FEED ---------------- */

async function previewFromFeed(req: NextRequest, body: any) {
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host")}`;

  const u = new URL("/api/admin/events-feed-bundles", origin);
  u.searchParams.set("month", body.month);
  u.searchParams.set("collection", body.collection);
  u.searchParams.set("source", body.source ?? "manual");

  const res = await fetch(u.toString(), {
    headers: { "x-admin-secret": req.headers.get("x-admin-secret") || "" },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`feed error: ${res.status} ${t}`);
  }
  const feed = await res.json();

  const preview: Array<{
    date: string;
    time: string;
    dayType: string | null;
    type?: string;
    bundleVariantIdGid?: string;
  }> = [];
  const warnings: string[] = [];

  if (Array.isArray(feed?.events)) {
    for (const d of feed.events) {
      const date = String(d?.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { warnings.push(`Giorno ignorato: date non valida "${d?.date}"`); continue; }
      const slots = Array.isArray(d?.slots) ? d.slots : [];
      for (const s of slots) {
        const time = String(s?.time || "").slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(time)) { warnings.push(`Slot ignorato: time non valido "${s?.time}" (${date})`); continue; }
        const dayType = s?.day_type || s?.dayType || null;

        const rows = [
          { type: "Adulto",   gid: s?.bundleVariantId_adulto },
          { type: "Bambino",  gid: s?.bundleVariantId_bambino },
          { type: "Handicap", gid: s?.bundleVariantId_handicap },
        ];
        let pushed = 0;
        for (const r of rows) {
          if (r.gid) {
            preview.push({ date, time, dayType, type: r.type, bundleVariantIdGid: r.gid });
            pushed++;
          }
        }
        if (!pushed) preview.push({ date, time, dayType, type: "Biglietto unico" });
      }
    }
  } else {
    warnings.push("Feed vuoto o in formato inatteso.");
  }

  return NextResponse.json(
    { ok: true, summary: { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 }, preview, warnings },
    { status: 200 }
  );
}

async function generateFromFeed(req: NextRequest, body: any) {
  // Validazioni minime per creazione reale
  if (body.dryRun !== false) {
    return NextResponse.json({ ok: false, error: "bad_request", detail: "dryRun:false richiesto per creare dal feed" }, { status: 400 });
  }
  if (!body["prices€"] || typeof body["prices€"] !== "object") {
    return NextResponse.json({ ok: false, error: "missing_prices", detail: 'Passa "prices€" nel body (per day type)' }, { status: 400 });
  }
  if (typeof body.capacityPerSlot !== "number" || body.capacityPerSlot <= 0) {
    return NextResponse.json({ ok: false, error: "missing_capacity", detail: 'Passa "capacityPerSlot" > 0' }, { status: 400 });
  }

  // 1) Leggi feed
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host")}`;

  const u = new URL("/api/admin/events-feed-bundles", origin);
  u.searchParams.set("month", body.month);
  u.searchParams.set("collection", body.collection);
  u.searchParams.set("source", body.source ?? "manual");

  const res = await fetch(u.toString(), {
    headers: { "x-admin-secret": req.headers.get("x-admin-secret") || "" },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`feed error: ${res.status} ${t}`);
  }
  const feed = await res.json();

  // 2) Helper per tipo giorno
  const toDayType = (s: any): DayType => {
    const v = String(s || "").toLowerCase();
    if (v === "holiday") return "holiday";
    if (v === "saturday") return "saturday";
    if (v === "sunday") return "sunday";
    if (v === "friday") return "friday";
    return "weekday";
  };

  // 3) Scorri eventi/slot e crea
  let seatsCreated = 0;
  let bundlesCreated = 0;
  let variantsCreated = 0;
  let inventoryAdjusted = 0;
  let relationshipsUpserted = 0;
  let pricesUpdated = 0;

  const preview: any[] = [];
  const warnings: string[] = [];

  const eventHandle = feed?.eventHandle || body.collection || "evento";
  const templateSuffix = body.templateSuffix;
  const tags = body.tags;
  const description = body.description;
  const locationId = body.locationId ?? null;
  const prices = body["prices€"] as PricesEuro;

  const getTierFor = (dt: DayType): PriceTierEuro | undefined => {
    if (dt === "holiday") return prices.holiday;
    if (dt === "saturday") return prices.saturday;
    if (dt === "sunday") return prices.sunday;
    if (dt === "friday") return prices.friday ?? prices.feriali;
    return prices.feriali;
  };

  const events = Array.isArray(feed?.events) ? feed.events : [];
  for (const d of events) {
    const date = String(d?.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { warnings.push(`Giorno ignorato: "${d?.date}"`); continue; }
    const slots = Array.isArray(d?.slots) ? d.slots : [];
    for (const s of slots) {
      const time = String(s?.time || "").slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(time)) { warnings.push(`Slot ignorato: "${s?.time}" (${date})`); continue; }
      const dt = toDayType(s?.day_type ?? s?.dayType);
      const tier = getTierFor(dt);
      if (!tier) { warnings.push(`Prezzi mancanti per ${date} ${time} (${dt})`); continue; }

      // crea/riusa Seat
      const seat = await ensureSeatUnit({
        date, time, titleBase: eventHandle, tags, description, templateSuffix, dryRun: false,
      });
      if (seat.created) {
        seatsCreated++;
        // attiva + pubblica
        await setProductActive(seat.productId);
        await publishProductToOnlineStore(seat.productId);
      }

      // stock iniziale
      await ensureInventory({
        variantId: seat.variantId, locationId: locationId ?? undefined, quantity: body.capacityPerSlot, dryRun: false,
      });
      inventoryAdjusted++;

      // modalità: dal feed impostiamo "triple" (Adulto/Bambino/Handicap)
      const bundle = await ensureBundle({
        eventHandle, date, time, titleBase: eventHandle, templateSuffix, tags, description,
        dayType: dt, mode: "triple", "priceTier€": tier, dryRun: false,
      });
      if (bundle.createdProduct) {
        bundlesCreated++;
        // attiva + pubblica
        await setProductActive(bundle.productId);
        await publishProductToOnlineStore(bundle.productId);
      }
      variantsCreated += bundle.createdVariants ?? 0;

      // collega componenti (qty: 1/1/2)
      const compPlan: (["adulto"|"bambino"|"handicap", number])[] = [["adulto",1],["bambino",1],["handicap",2]];
      for (const [k, qty] of compPlan) {
        const parentVariantId = bundle.variantMap[k];
        if (!parentVariantId) continue;
        await ensureVariantLeadsToSeat({
          bundleVariantId: parentVariantId,
          seatVariantId: seat.variantId,
          componentQuantity: qty,
          dryRun: false,
        });
        relationshipsUpserted++;
      }

      // prezzi
      const pricesToSet: Record<string, number | undefined> = {};
      if (bundle.variantMap.adulto && typeof tier.adulto === "number")   pricesToSet[bundle.variantMap.adulto] = tier.adulto;
      if (bundle.variantMap.bambino && typeof tier.bambino === "number") pricesToSet[bundle.variantMap.bambino] = tier.bambino;
      if (bundle.variantMap.handicap && typeof tier.handicap === "number") pricesToSet[bundle.variantMap.handicap] = tier.handicap;

      if (Object.keys(pricesToSet).length) {
        await setVariantPrices(bundle.productId, pricesToSet);
        pricesUpdated += Object.keys(pricesToSet).length;
      }

      // preview breve (solo primi 10)
      if (preview.length < 10) {
        preview.push({
          date, time, dayType: dt,
          seatProductId: seat.productId,
          bundleProductId: bundle.productId,
          variantMap: bundle.variantMap,
        });
      }
    }
  }

  return NextResponse.json(
    {
      ok: true,
      summary: {
        seatsCreated,
        bundlesCreated,
        variantsCreated,
        inventoryAdjusted,
        relationshipsUpserted,
        pricesUpdated,
      },
      preview,
      warnings,
    },
    { status: 200 }
  );
}

/* ---------------- route: POST ---------------- */

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

    // Se arrivano month+collection: feed (preview o creazione)
    const anyBody = body as any;
    if (anyBody?.month && anyBody?.collection) {
      if (anyBody.dryRun === false) {
        return await generateFromFeed(req, anyBody);
      }
      return await previewFromFeed(req, anyBody);
    }

    // Altrimenti accettiamo solo source:"manual"
    if (body.source !== "manual") {
      return NextResponse.json(
        { ok: false, error: "source_not_supported_yet", detail: 'Usa {"source":"manual"} oppure passa month+collection per il feed' },
        { status: 400 }
      );
    }

    /* ------- ramo MANUAL esistente ------- */

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
        const item: PreviewItem = { date, time, dayType: dt, "pricePlan€": tier, mode: mode as any };

        if (!tier || !mode) {
          item.warnings = item.warnings ?? [];
          if (!tier) item.warnings.push("Nessun listino prezzi per questo slot");
          if (!mode) item.warnings.push("Definisci 'unico' o almeno una tra adulto/bambino/handicap");
          if (preview.length < 10) preview.push(item);
          continue;
        }

        // Seat Unit
        const seat = await ensureSeatUnit({
          date, time, titleBase: input.eventHandle, tags, description, templateSuffix, dryRun,
        });
        if (!dryRun && seat.created) {
          seatsCreated++;
          await setProductActive(seat.productId);
          await publishProductToOnlineStore(seat.productId);
        }

        // Stock iniziale
        await ensureInventory({
          variantId: seat.variantId,
          locationId: input.locationId,
          quantity: input.capacityPerSlot,
          dryRun,
        });

        // Bundle
        const bundle = await ensureBundle({
          eventHandle: input.eventHandle,
          date, time, titleBase: input.eventHandle,
          templateSuffix, tags, description,
          dayType: dt, mode, "priceTier€": tier,
          dryRun,
        });
        if (!dryRun) {
          if (bundle.createdProduct) {
            bundlesCreated++;
            await setProductActive(bundle.productId);
            await publishProductToOnlineStore(bundle.productId);
          }
          if (typeof bundle.createdVariants === "number") variantsCreated += bundle.createdVariants;
        }

        // Componenti (collega variante seat) — qty 1 per tutte, handicap = 2
        const compOps: (["unico"|"adulto"|"bambino"|"handicap", number])[] =
          mode === "unico" ? [["unico", 1]] : [["adulto", 1], ["bambino", 1], ["handicap", 2]];
        if (!dryRun) {
          for (const [k, qty] of compOps) {
            const parentVariantId = bundle.variantMap[k];
            if (!parentVariantId) continue;
            await ensureVariantLeadsToSeat({
              bundleVariantId: parentVariantId,
              seatVariantId: seat.variantId,
              componentQuantity: qty,
              dryRun: false,
            });
          }
        }

        // Prezzi
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

        // Preview (solo primi 10)
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

/* ---------------- CORS (aperto per test) ---------------- */

export async function OPTIONS() {
  return NextResponse.json(
    { ok: true },
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, x-admin-secret",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    }
  );
}
