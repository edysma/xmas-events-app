// app/api/admin/generate-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getShopPublicHolidays } from "@/lib/shopify-admin";
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

// Lista date inclusive [start, end], formattate YYYY-MM-DD (UTC-safe)
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

// Weekday in fuso Europe/Rome → 1..7 (lun..dom)
function weekdayRome(date: string): number {
  const name = new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    timeZone: TZ,
  })
    .format(new Date(date + "T12:00:00Z"))
    .toLowerCase(); // evita bordi DST
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
  return (["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const)[w]!;
}

function dayTypeOf(
  date: string,
  holidays: Set<string>,
): DayType {
  if (holidays.has(date)) return "holiday";
  const w = weekdayRome(date);
  if (w === 6) return "saturday";
  if (w === 7) return "sunday";
  if (w === 5) return "friday";
  return "weekday";
}

function pickTierForDate(
  date: string,
  dt: DayType,
  prices: PricesEuro,
  fridayAsWeekend: boolean,
  exceptionsByDate?: Record<string, PriceTierEuro>
): PriceTierEuro | undefined {
  // 1) Eccezioni per data (override totale)
  if (exceptionsByDate && exceptionsByDate[date]) {
    return exceptionsByDate[date];
  }

  // 2) Regole per tipo giorno
  if (dt === "holiday") return prices.holiday;
  if (dt === "saturday") return prices.saturday;
  if (dt === "sunday") return prices.sunday;

  if (dt === "friday") {
    if (fridayAsWeekend) {
      // Venerdì come weekend: usa prezzi sabato (come da playbook)
      return prices.saturday ?? prices.sunday ?? prices.holiday ?? prices.feriali;
    }
    // Venerdì normale: se c'è una sezione Friday dedicata, usa quella; altrimenti fallback a feriali
    return prices.friday ?? prices.feriali;
  }

  // weekday (lun-gio): prima perDay se presente, poi feriali "generale"
  const wk = weekdayKey(date);
  if (wk === "mon" || wk === "tue" || wk === "wed" || wk === "thu") {
    const perDay = prices.feriali?.perDay;
    if (perDay) {
      if (wk === "mon" && perDay.mon) return perDay.mon;
      if (wk === "tue" && perDay.tue) return perDay.tue;
      if (wk === "wed" && perDay.wed) return perDay.wed;
      if (wk === "thu" && perDay.thu) return perDay.thu;
    }
    return prices.feriali;
  }

  return prices.feriali;
}

function decideMode(tier?: PriceTierEuro): "unico" | "triple" | undefined {
  if (!tier) return undefined;
  if (typeof tier.unico === "number") return "unico";
  if (
    typeof tier.adulto === "number" ||
    typeof tier.bambino === "number" ||
    typeof tier.handicap === "number"
  ) {
    return "triple";
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: GenerateInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Step iniziale: supportiamo solo source:"manual" in dry-run (preview)
  if (body.source !== "manual") {
    return NextResponse.json(
      { ok: false, error: "source_not_supported_yet", detail: 'Per ora usa {"source":"manual"}' },
      { status: 400 }
    );
  }

  const input = body as ManualInput;

  // Holidays dal metafield shop
  const holidaysArr = await getShopPublicHolidays();
  const holidays = new Set(holidaysArr);

  const dates = listDates(input.startDate, input.endDate);
  const preview: PreviewItem[] = [];
  const warningsGlobal: string[] = [];

  for (const date of dates) {
    const dt = dayTypeOf(date, holidays);

    // Scelta slot (Friday come weekend se fridayAsWeekend=true)
    const useWeekendSlots =
      dt === "saturday" ||
      dt === "sunday" ||
      dt === "holiday" ||
      (dt === "friday" && input.fridayAsWeekend);
    const slots = useWeekendSlots ? input.weekendSlots : input.weekdaySlots;

    // Prezzi per il giorno (con eccezioni)
    const tier = pickTierForDate(date, dt, input["prices€"], input.fridayAsWeekend, input.exceptionsByDate);
    const mode = decideMode(tier);

    // Warning se non c'è una definizione prezzi
    let localWarn: string[] = [];
    if (!tier) {
      localWarn.push("Nessun listino prezzi trovato per questo giorno");
    } else if (!mode) {
      localWarn.push("Struttura prezzi ambigua: definisci 'unico' oppure almeno uno tra adulto/bambino/handicap");
    }

    for (const time of slots) {
      if (preview.length < 10) {
        const item: PreviewItem = {
          date,
          time,
          dayType: dt,
          "pricePlan€": tier,
          mode: mode as any, // opzionale nella preview
        };
        if (localWarn.length) item.warnings = localWarn;
        preview.push(item);
      }
    }
  }

  const resp: GenerateResponse = {
    ok: true,
    summary: { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 },
    preview,
    warnings: warningsGlobal,
  };

  return NextResponse.json(resp, { status: 200 });
}
