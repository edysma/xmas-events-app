// app/api/admin/generate-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getShopPublicHolidays } from "@/lib/shopify-admin";
import {
  ensureSeatUnit,
  ensureInventory,
  ensureBundle,
  setVariantPrices,
  upsertBundleComponents,
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

export async function POST(req: NextRequest) {
  try {
    const secret = req.headers.get("x-admin-secret");
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    let body: GenerateInput & { dryRun?: boolean; templateSuffix?: string; tags?: string[]; description?: string; imageUrl?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }

    if (body.source !== "manual") {
      return NextResponse.json(
        { ok: false, error: "source_not_supported_yet", detail: 'Per ora usa {"source":"manual"}' },
        { status: 400 }
      );
    }

    const input = body as ManualInput & { dryRun?: boolean; templateSuffix?: string; tags?: string[]; description?: string; imageUrl?: string };
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

        const seat = await ensureSeatUnit({
          date,
          time,
          titleBase: input.eventHandle,
          tags,
          description,
          templateSuffix,
          dryRun,
        });

        await ensureInventory({
          variantId: seat.variantId,
          locationId: input.locationId,
          quantity: input.capacityPerSlot,
          dryRun,
        });

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

        const compOps: [keyof typeof bundle.variants, number][] =
          mode === "unico" ? [["unico", 1]] : [["adulto", 1], ["bambino", 1], ["handicap", 2]];

        for (const [k, qty] of compOps) {
          const parentVariantId = bundle.variants[k];
          if (!parentVariantId) continue;
          await upsertBundleComponents({
            parentVariantId,
            childVariantId: seat.variantId,
            qty,
            dryRun,
          });
        }

        if (mode === "unico" && typeof tier.unico === "number" && bundle.variants.unico) {
          await setVariantPrices({ variantId: bundle.variants.unico, priceEuro: tier.unico, dryRun });
        }
        if (mode === "triple") {
          if (typeof tier.adulto === "number" && bundle.variants.adulto) {
            await setVariantPrices({ variantId: bundle.variants.adulto, priceEuro: tier.adulto, dryRun });
          }
          if (typeof tier.bambino === "number" && bundle.variants.bambino) {
            await setVariantPrices({ variantId: bundle.variants.bambino, priceEuro: tier.bambino, dryRun });
          }
          if (typeof tier.handicap === "number" && bundle.variants.handicap) {
            await setVariantPrices({ variantId: bundle.variants.handicap, priceEuro: tier.handicap, dryRun });
          }
        }

        if (!dryRun) {
          if (seat.created) seatsCreated += 1;
          if (bundle.created) bundlesCreated += 1;
        }

        if (preview.length < 10) {
          item.seatProductId = seat.productId;
          item.bundleProductId = bundle.productId;
          item.variantMap = {
            unico: bundle.variants.unico,
            adulto: bundle.variants.adulto,
            bambino: bundle.variants.bambino,
            handicap: bundle.variants.handicap,
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
    // Restituiamo SEMPRE JSON in caso di eccezione
    return NextResponse.json(
      {
        ok: false,
        error: "internal_error",
        detail: String(err?.message || err),
      },
      { status: 500 }
    );
  }
}
