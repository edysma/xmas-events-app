// lib/feed-bundles.ts
// Helper per trovare il prodotto "Bundle" (per titolo) e mappare le varianti
// + util per dayType coerente con Europe/Rome.

import { adminFetchGQL } from "@/lib/shopify-admin";

export type DayType = "weekday" | "friday" | "saturday" | "sunday" | "holiday";

const TZ = "Europe/Rome";

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

export function buildBundleTitle(titleBase: string, date: string, time: string) {
  // Stessa convenzione usata nel generatore:
  // `${titleBase} — YYYY-MM-DD HH:mm`
  return `${titleBase} — ${date} ${time}`;
}

export function weekdayRome(date: string): number {
  const name = new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    timeZone: TZ,
  })
    .format(new Date(date + "T12:00:00Z"))
    .toLowerCase();

  const map: Record<string, number> = { lun: 1, mar: 2, mer: 3, gio: 4, ven: 5, sab: 6, dom: 7 };
  return map[name] ?? 0;
}

export function dayTypeOf(date: string, holidays: Set<string>): DayType {
  if (holidays.has(date)) return "holiday";
  const w = weekdayRome(date);
  if (w === 6) return "saturday";
  if (w === 7) return "sunday";
  if (w === 5) return "friday";
  return "weekday";
}

// Cache in-memory per ridurre chiamate duplicate (chiave = titolo esatto)
const productCache = new Map<string, {
  productId: string;
  variantMap: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined>;
}>();

const Q_FIND_PRODUCT_BY_TITLE = /* GraphQL */ `
  query FindProductByTitle($q: String!) {
    products(first: 1, query: $q) {
      edges {
        node {
          id
          title
          variants(first: 20) {
            edges {
              node {
                id
                title
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

// Ritorna la mappa varianti del Bundle per (eventHandle, date, time).
// Se il prodotto non esiste, ritorna undefined (il feed rimane comunque valido).
export async function getBundleVariantMap(eventHandle: string, date: string, time: string): Promise<{
  productId: string;
  variantMap: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined>;
} | undefined> {
  // Normalizza time (accetta anche "HH:mm" o "H:m")
  const d = new Date(`${date}T00:00:00Z`);
  const iso = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const tParts = time.split(":").map(x => parseInt(x, 10));
  const hh = pad2((tParts[0] || 0));
  const mm = pad2((tParts[1] || 0));
  const normTime = `${hh}:${mm}`;

  const title = buildBundleTitle(eventHandle, iso, normTime);
  if (productCache.has(title)) return productCache.get(title);

  const q = `title:"${title.replace(/"/g, '\\"')}"`;
  const data = await adminFetchGQL<{ products: { edges: { node: any }[] } }>(Q_FIND_PRODUCT_BY_TITLE, { q });
  const node = data.products?.edges?.[0]?.node;
  if (!node?.id) return undefined;

  const map: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
    unico: undefined, adulto: undefined, bambino: undefined, handicap: undefined,
  };

  for (const e of node.variants?.edges || []) {
    const v = e.node;
    const label = (v.selectedOptions?.[0]?.value || v.title || "").toLowerCase();
    if (label.includes("unico")) map.unico = v.id;
    else if (label.includes("adulto")) map.adulto = v.id;
    else if (label.includes("bambino")) map.bambino = v.id;
    else if (label.includes("handicap")) map.handicap = v.id;
  }

  const out = { productId: node.id, variantMap: map };
  productCache.set(title, out);
  return out;
}
