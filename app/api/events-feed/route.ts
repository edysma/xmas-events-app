// app/api/events-feed/route.ts
import { NextRequest, NextResponse } from "next/server";

// Evita caching aggressivo su Vercel/Next per questa rotta pubblica
export const dynamic = "force-dynamic";

/* ---------------- Storefront GQL client (pubblico) ---------------- */

async function sfGQL<T>(query: string, variables: Record<string, any>): Promise<T> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN!;
  // ✅ usa la stessa env usata nella /api/sf-health
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN!;

  if (!domain || !token) throw new Error("Missing Storefront envs");

  const res = await fetch(`https://${domain}/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Shopify-Storefront-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Storefront ${res.status}`);
  const j = await res.json();
  return j.data as T;
}

/** Parser data/ora dal titolo prodotto.
 * Supporta:
 *  - "… — YYYY-MM-DD HH:mm"  (ISO)
 *  - "… — DD/MM/YYYY HH:mm"  (italiano)
 * Accetta sia EN DASH "—" sia trattino "-".
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

function isInMonth(date: string, month: string) {
  // month = "YYYY-MM"
  return date.startsWith(month + "-");
}

const TZ = "Europe/Rome";
function weekdayRome(date: string): number {
  const name = new Intl.DateTimeFormat("it-IT", { weekday: "short", timeZone: TZ })
    .format(new Date(date + "T12:00:00Z"))
    .toLowerCase();
  const map: Record<string, number> = { lun: 1, mar: 2, mer: 3, gio: 4, ven: 5, sab: 6, dom: 7 };
  return map[name] ?? 0;
}
function dayTypeOf(date: string): "weekday" | "friday" | "saturday" | "sunday" | "holiday" {
  const w = weekdayRome(date);
  if (w === 6) return "saturday";
  if (w === 7) return "sunday";
  if (w === 5) return "friday";
  return "weekday";
}

/* ---------------- GQL ---------------- */

const Q_COLLECTION_PRODUCTS = /* GraphQL */ `
  query CollectionByHandle($handle: String!, $cursor: String) {
    collection(handle: $handle) {
      products(first: 100, after: $cursor) {
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
  }
`;

/* Esplicito i tipi per evitare errori TS */
type SfCollectionProductsResp = {
  collection: {
    products: {
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          title: string;
          tags: string[];
          variants: { edges: Array<{ node: { id: string; title: string } }> };
        };
      }>;
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
};

/* Dalla lista varianti capisco se è "unico" o "triple" e mappo gli ID */
function extractVariantMap(variants: Array<{ title: string; id: string }>) {
  const out: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
    unico: undefined,
    adulto: undefined,
    bambino: undefined,
    handicap: undefined,
  };
  for (const v of variants) {
    const t = (v.title || "").toLowerCase();
    if (t.includes("unico")) out.unico = v.id;
    else if (t.includes("adulto")) out.adulto = v.id;
    else if (t.includes("bambino")) out.bambino = v.id;
    else if (t.includes("handicap")) out.handicap = v.id;
  }
  const mode: "unico" | "triple" | null =
    out.unico ? "unico" : out.adulto || out.bambino || out.handicap ? "triple" : null;
  return { mode, map: out };
}

/* ---------------- Route pubblica ---------------- */

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const month = searchParams.get("month") || "";
    const collection = searchParams.get("collection") || "";

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ ok: false, error: "invalid_month" }, { status: 400 });
    }
    if (!collection) {
      return NextResponse.json({ ok: false, error: "missing_collection" }, { status: 400 });
    }

    // 1) Carico i prodotti della collezione dal canale pubblico (Storefront)
    let cursor: string | null = null;
    const products: Array<{
      id: string;
      title: string;
      tags: string[];
      variants: Array<{ id: string; title: string }>;
    }> = [];

    while (true) {
      const data: SfCollectionProductsResp = await sfGQL<SfCollectionProductsResp>(
        Q_COLLECTION_PRODUCTS,
        { handle: collection, cursor }
      );

      const edges = data.collection?.products.edges || [];
      for (const e of edges) {
        products.push({
          id: e.node.id,
          title: e.node.title,
          tags: e.node.tags || [],
          variants: (e.node.variants?.edges || []).map((x) => ({
            id: x.node.id,
            title: x.node.title,
          })),
        });
      }
      if (!data.collection?.products.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
    }

    // 2) Tengo solo i “Bundle” (tag Bundle) e costruisco il calendario del mese richiesto
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
      if (!p.tags?.includes("Bundle")) continue;

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
        if (map.adulto) slot.bundleVariantId_adulto = map.adulto;
        if (map.bambino) slot.bundleVariantId_bambino = map.bambino;
        if (map.handicap) slot.bundleVariantId_handicap = map.handicap;
      }

      byDate[parsed.date] = byDate[parsed.date] || [];
      byDate[parsed.date].push(slot);
    }

    const events = Object.keys(byDate)
      .sort()
      .map((date) => ({ date, slots: byDate[date].sort((a, b) => a.time.localeCompare(b.time)) }));

    return NextResponse.json({ month, events }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { month: "", events: [], error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
