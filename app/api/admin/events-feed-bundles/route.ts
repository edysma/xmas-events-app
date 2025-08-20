// app/api/admin/events-feed-bundles/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

/**
 * Estrae data/ora dal titolo prodotto.
 * Supporta entrambe le forme:
 *   - "… — YYYY-MM-DD HH:mm"
 *   - "… — DD/MM/YYYY HH:mm"
 * Accetta sia EN DASH "—" che trattino "-".
 */
function parseTitleForDateTime(title: string): { date: string; time: string } | null {
  // Accetta sia YYYY-MM-DD che DD/MM/YYYY dopo il "—" (o "-") + HH:mm
  const m =
    title.match(/—\s*([0-9/ -]{10})\s+(\d{2}:\d{2})$/) ||
    title.match(/-\s*([0-9/ -]{10})\s+(\d{2}:\d{2})$/);
  if (!m) return null;

  const rawDate = m[1].trim();
  const time = m[2];

  // Se è DD/MM/YYYY -> converti in YYYY-MM-DD
  let yyyyMmDd: string;
  if (rawDate.includes("/")) {
    const [dd, mm, yyyy] = rawDate.split("/");
    if (!yyyy || !mm || !dd) return null;
    yyyyMmDd = `${yyyy}-${mm}-${dd}`;
  } else {
    // Già nel formato YYYY-MM-DD
    yyyyMmDd = rawDate;
  }

  return { date: yyyyMmDd, time };
}


const TZ = "Europe/Rome";

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
function dayTypeOf(date: string): "weekday" | "friday" | "saturday" | "sunday" | "holiday" {
  const w = weekdayRome(date);
  if (w === 6) return "saturday";
  if (w === 7) return "sunday";
  if (w === 5) return "friday";
  return "weekday";
}
function isInMonth(date: string, month: string) {
  // month = "YYYY-MM"
  return date.startsWith(month + "-");
}

async function fetchPublicFeed(baseUrl: string, month: string, collection: string) {
  const url = `${baseUrl}/api/events-feed?month=${encodeURIComponent(month)}&collection=${encodeURIComponent(collection)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

const Q_PRODUCTS_BY_QUERY = /* GraphQL */ `
  query FindBundles($q: String!, $after: String) {
    products(first: 100, query: $q, after: $after) {
      edges {
        cursor
        node {
          id
          title
          tags
          variants(first: 20) {
            edges { node { id title } }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

// Dalla lista varianti, individua se "unico" oppure triple, e mappa ID.
function extractVariantMap(variants: Array<{ title: string; id: string }>) {
  const out: Record<"unico"|"adulto"|"bambino"|"handicap", string|undefined> = {
    unico: undefined, adulto: undefined, bambino: undefined, handicap: undefined
  };
  for (const v of variants) {
    const t = (v.title || "").toLowerCase();
    if (t.includes("unico")) out.unico = v.id;
    else if (t.includes("adulto")) out.adulto = v.id;
    else if (t.includes("bambino")) out.bambino = v.id;
    else if (t.includes("handicap")) out.handicap = v.id;
  }
  const mode: "unico" | "triple" | null = out.unico ? "unico" : (out.adulto || out.bambino || out.handicap) ? "triple" : null;
  return { mode, map: out };
}

export async function GET(req: NextRequest) {
  try {
    const secret = req.headers.get("x-admin-secret");
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const month = searchParams.get("month") || "";
    const eventHandle = searchParams.get("collection") || "";
    const base = `${req.nextUrl.origin}`;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ ok: false, error: "invalid_month" }, { status: 400 });
    }
    if (!eventHandle) {
      return NextResponse.json({ ok: false, error: "missing_collection" }, { status: 400 });
    }

    // 1) Prova con feed pubblico (se esiste e ha eventi)
    try {
      const upstream = await fetchPublicFeed(base, month, eventHandle);
      if (Array.isArray(upstream?.events) && upstream.events.length > 0) {
        return NextResponse.json({ ok: true, month, eventHandle, events: upstream.events }, { status: 200 });
      }
    } catch {
      // ignora: useremo il fallback
    }

    // 2) Fallback: cerca i Bundle direttamente in Shopify (prodotti attivi con i tag corretti)
    const q = `tag:${eventHandle} AND tag:Bundle AND status:active`;
    type GqlResp = {
      products: {
        edges: { cursor: string; node: { id: string; title: string; variants?: { edges: { node: { id: string; title: string } }[] } } }[];
        pageInfo: { hasNextPage: boolean };
      };
    };

    let after: string | null = null;
    const products: Array<{ id: string; title: string; variants: Array<{ id: string; title: string }> }> = [];

    while (true) {
      const resp: GqlResp = await adminFetchGQL<GqlResp>(Q_PRODUCTS_BY_QUERY, { q, after });
      for (const e of resp.products.edges) {
        const node = e.node;
        products.push({
          id: node.id,
          title: node.title,
          variants: (node.variants?.edges || []).map((x) => ({ id: x.node.id, title: x.node.title })),
        });
      }
      if (!resp.products.pageInfo.hasNextPage) break;
      after = resp.products.edges[resp.products.edges.length - 1].cursor;
    }

    // 3) Costruisci giorni/slot leggendo data/ora dal titolo
    type Slot = {
      time: string;
      day_type: "weekday" | "friday" | "saturday" | "sunday" | "holiday";
      bundleVariantId_single?: string;
      bundleVariantId_adulto?: string;
      bundleVariantId_bambino?: string;
      bundleVariantId_handicap?: string;
    };
    const byDate: Record<string, Slot[]> = {};

    for (const p of products) {
      const parsed = parseTitleForDateTime(p.title);
      if (!parsed) continue;
      if (!isInMonth(parsed.date, month)) continue;

      const { mode, map } = extractVariantMap(p.variants);
      if (!mode) continue;

      const dt = dayTypeOf(parsed.date);
      const slot: Slot = { time: parsed.time, day_type: dt };
      if (mode === "unico") {
        if (map.unico) slot.bundleVariantId_single = map.unico;
      } else {
        if (map.adulto)   slot.bundleVariantId_adulto   = map.adulto;
        if (map.bambino)  slot.bundleVariantId_bambino  = map.bambino;
        if (map.handicap) slot.bundleVariantId_handicap = map.handicap;
      }

      byDate[parsed.date] = byDate[parsed.date] || [];
      byDate[parsed.date].push(slot);
    }

    // Ordina i giorni e le fasce orarie
    const days = Object.keys(byDate).sort().map((date) => {
      const slots = byDate[date].sort((a, b) => a.time.localeCompare(b.time));
      return { date, slots };
    });

    return NextResponse.json({ ok: true, month, eventHandle, events: days }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: "internal_error", detail: String(err?.message || err) }, { status: 500 });
  }
}
