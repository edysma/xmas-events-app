// app/api/admin/generate-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getShopPublicHolidays } from "@/lib/shopify-admin";
import type {
  GenerateInput,
  ManualInput,
  PreviewItem,
  GenerateResponse,
  DayType,
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
  }).format(new Date(date + "T12:00:00Z")).toLowerCase(); // evita bordi DST
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

function dayTypeOf(
  date: string,
  holidays: Set<string>,
  fridayAsWeekend: boolean
): DayType {
  if (holidays.has(date)) return "holiday";
  const w = weekdayRome(date);
  if (w === 6) return "saturday";
  if (w === 7) return "sunday";
  if (w === 5) return "friday";
  return "weekday";
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

  for (const date of dates) {
    const dt = dayTypeOf(date, holidays, input.fridayAsWeekend);
    // Scelta slot (Friday come weekend se fridayAsWeekend=true)
    const useWeekendSlots =
      dt === "saturday" || dt === "sunday" || dt === "holiday" || (dt === "friday" && input.fridayAsWeekend);
    const slots = useWeekendSlots ? input.weekendSlots : input.weekdaySlots;

    for (const time of slots) {
      if (preview.length < 10) preview.push({ date, time });
    }
  }

  const resp: GenerateResponse = {
    ok: true,
    summary: { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 },
    preview,
    warnings: [],
  };

  return NextResponse.json(resp, { status: 200 });
}
