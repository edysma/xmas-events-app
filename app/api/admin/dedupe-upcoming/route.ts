// app/api/admin/dedupe-upcoming/route.ts
import { NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

type CompNode = {
  productVariant?: { id?: string | null; title?: string | null } | null;
  quantity?: number | null;
} | null;

type VariantNode = {
  id: string;
  title?: string | null;
  // metafield singolare (NO identifiers)
  seatsMeta?: { value?: string | null } | null;
  productVariantComponents?: { nodes?: CompNode[] | null } | null;
} | null;

type ProductNode = {
  id: string;
  variants?: { edges?: { node?: VariantNode }[] | null } | null;
} | null;

type ListResp = {
  products?: {
    edges?: { cursor?: string | null; node?: ProductNode }[] | null;
    pageInfo?: { hasNextPage?: boolean | null } | null;
  } | null;
};

const Q_LIST_VARIANTS = /* GraphQL */ `
  query List($cursor: String, $q: String!) {
    products(first: 30, after: $cursor, query: $q) {
      edges {
        cursor
        node {
          id
          variants(first: 50) {
            edges {
              node {
                id
                title
                seatsMeta: metafield(namespace: "sinflora", key: "seats_per_ticket") { value }
                productVariantComponents(first: 50) {
                  nodes {
                    productVariant { id title }
                    quantity
                  }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const M_REL_BULK = /* GraphQL */ `
  mutation PVRRelBulkUpdate($input: [ProductVariantRelationshipUpdateInput!]!) {
    productVariantRelationshipBulkUpdate(input: $input) {
      userErrors { field message }
    }
  }
`;

export const dynamic = "force-dynamic";

function expectedQtyForVariant(title?: string | null, seatsMeta?: { value?: string | null } | null) {
  const mf = seatsMeta?.value;
  if (mf && Number.isFinite(Number(mf))) return Math.max(1, parseInt(mf, 10));
  if (title && /handicap/i.test(title)) return 2;
  return 1;
}

async function listFixInputs(q: string, limit: number | null) {
  const fixes: {
    parentId: string; // bundle variant id
    seatId: string;   // seat unit variant id
    qty: number;      // desired qty
    reason: string;
    variantTitle?: string | null;
  }[] = [];

  let cursor: string | null = null;

  for (;;) {
    const raw = await adminFetchGQL(Q_LIST_VARIANTS, { cursor, q });
    const data = (raw as unknown) as ListResp;

    const edges = data?.products?.edges ?? [];
    for (const e of edges) {
      const vEdges = e?.node?.variants?.edges ?? [];
      for (const ve of vEdges) {
        const v = ve?.node;
        if (!v || !v.id) continue;

        const comps = v.productVariantComponents?.nodes ?? [];
        const childIds = comps
          .map((c) => c?.productVariant?.id)
          .filter((x): x is string => Boolean(x));

        if (!childIds.length) {
          // Nessun componente: non tocchiamo (non è un bundle valido per noi)
          continue;
        }

        // Gruppo per childId
        const byChild = new Map<string, { count: number; totalQty: number }>();
        for (const c of comps) {
          const id = c?.productVariant?.id!;
          const qty = Number(c?.quantity ?? 0) || 0;
          const prev = byChild.get(id) || { count: 0, totalQty: 0 };
          prev.count += 1;
          prev.totalQty += qty;
          byChild.set(id, prev);
        }

        const desired = expectedQtyForVariant(v.title, v.seatsMeta);

        if (byChild.size !== 1) {
          // Ambiguità: più di una Seat Unit collegata; segnalo per fix “hard”
          for (const [childId, agg] of byChild.entries()) {
            if (agg.count > 1 || agg.totalQty !== desired) {
              fixes.push({
                parentId: v.id,
                seatId: childId,
                qty: desired,
                reason: `ambiguous(${byChild.size}) or qty!=${desired}`,
                variantTitle: v.title ?? null,
              });
            }
          }
          if (limit && fixes.length >= limit) return fixes;
          continue;
        }

        const [onlyChildId, agg] = Array.from(byChild.entries())[0];

        // Condizioni che richiedono fix:
        // - duplicati (count > 1)
        // - qty errata rispetto alla regola attesa
        if (agg.count > 1 || agg.totalQty !== desired) {
          fixes.push({
            parentId: v.id,
            seatId: onlyChildId,
            qty: desired,
            reason: agg.count > 1 ? "duplicates" : `qty!=${desired}`,
            variantTitle: v.title ?? null,
          });
        }

        if (limit && fixes.length >= limit) return fixes;
      }
    }

    const hasNext = Boolean(data?.products?.pageInfo?.hasNextPage);
    cursor = hasNext ? (edges[edges.length - 1]?.cursor ?? null) : null;
    if (!cursor) break;
  }

  return fixes;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret") || req.headers.get("x-admin-secret") || "";
    if (!process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "ADMIN_SECRET not set" }, { status: 401 });
    }
    if (!secret) {
      return NextResponse.json({ ok: false, error: 'Missing "secret"' }, { status: 401 });
    }
    if (secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "Secret mismatch" }, { status: 401 });
    }

    const dryRun = /^(1|true)$/i.test(url.searchParams.get("dryRun") || "");
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Number.parseInt(limitParam, 10) || 0) : null;
    const debug = /^(1|true)$/i.test(url.searchParams.get("debug") || "");

    // ✅ Query specifica per Wondy se non ne passi una tu
    const q = url.searchParams.get("query") || "tag:wondy status:active";

    const fixes = await listFixInputs(q, limit);

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        variantsFound: fixes.length,
        sample: debug ? fixes.slice(0, 3) : undefined,
        query: q,
      });
    }

    if (!fixes.length) {
      return NextResponse.json({ ok: true, updated: 0, note: "No fixes required", query: q });
    }

    let updated = 0;
    for (let i = 0; i < fixes.length; i += 20) {
      const slice = fixes.slice(i, i + 20).map((f) => ({
        parentProductVariantId: f.parentId,
        productVariantRelationshipsToRemove: [f.seatId],
        productVariantRelationshipsToCreate: [{ id: f.seatId, quantity: f.qty }],
      }));

      const res = await adminFetchGQL<{
        productVariantRelationshipBulkUpdate?: { userErrors?: { message?: string }[] } | null;
      }>(M_REL_BULK, { input: slice });

      const errs = res?.productVariantRelationshipBulkUpdate?.userErrors ?? [];
      if (errs.length) {
        const msg = errs.map((e) => e?.message).join(" | ");
        return NextResponse.json({ ok: false, error: msg, at: i }, { status: 500 });
      }
      updated += slice.length;
    }

    return NextResponse.json({ ok: true, updated, query: q });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
