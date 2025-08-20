// app/api/admin/events-feed-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getShopPublicHolidays } from "@/lib/shopify-admin";
import { getBundleVariantMap, dayTypeOf } from "@/lib/feed-bundles";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 1) sicurezza
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 2) parametri
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || "";
  const eventHandle = searchParams.get("collection") || searchParams.get("eventHandle") || "";
  if (!month) {
    return NextResponse.json({ ok: false, error: "missing_month" }, { status: 400 });
  }
  if (!eventHandle) {
    return NextResponse.json({ ok: false, error: "missing_collection_eventHandle" }, { status: 400 });
  }

  try {
    // 3) chiama l’endpoint pubblico ESISTENTE senza toccarlo
    const origin = new URL(req.url).origin;
    const publicUrl = `${origin}/api/events-feed?month=${encodeURIComponent(
      month
    )}&collection=${encodeURIComponent(eventHandle)}`;
    const baseResp = await fetch(publicUrl, { cache: "no-store" });
    if (!baseResp.ok) {
      const txt = await baseResp.text();
      return NextResponse.json(
        { ok: false, error: "feed_upstream_error", detail: `HTTP ${baseResp.status}: ${txt.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const base = await baseResp.json();

    // Atteso: base.days[] con { date, slots[] } (manteniamo struttura e aggiungiamo solo campi)
    const days = Array.isArray(base?.days) ? base.days : [];
    const holidays = new Set(await getShopPublicHolidays());

    for (const d of days) {
      const date = d?.date as string;
      if (!date || !Array.isArray(d?.slots)) continue;

      for (const s of d.slots) {
        const time = (s?.time as string) || (s?.slot as string);
        if (!time) continue;

        // day_type: se assente lo calcoliamo
        s.day_type = s.day_type || dayTypeOf(date, holidays);

        // cerca il Bundle creato per questo (evento, data, ora)
        const found = await getBundleVariantMap(eventHandle, date, time);
        if (!found) continue; // bundle non esiste ancora → nessun ID da aggiungere

        const vm = found.variantMap;
        // Se c'è "unico", esponiamo il campo single; altrimenti triple
        if (vm.unico) {
          s.bundleVariantId_single = vm.unico;
        } else {
          if (vm.adulto) s.bundleVariantId_adulto = vm.adulto;
          if (vm.bambino) s.bundleVariantId_bambino = vm.bambino;
          if (vm.handicap) s.bundleVariantId_handicap = vm.handicap;
        }
      }
    }

    return NextResponse.json(
      {
        ok: true,
        month,
        eventHandle,
        // ritorniamo tutto il payload originale + i nuovi campi sugli slot
        ...base,
      },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "internal_error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}
