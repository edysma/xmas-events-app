// app/api/admin/dedupe-upcoming/route.ts
import { NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

type Metafield = { key?: string | null; value?: string | null } | null;
type VariantNode = { id: string; title?: string | null; metafields?: Metafield[] | null } | null;
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

const Q_LIST_BUNDLE_VARIANTS = /* GraphQL */ `
  query List($cursor: String) {
    products(first: 30, after: $cursor, query: "tag:Bundle status:active") {
      edges {
        cursor
        node {
          id
          variants(first: 50) {
            edges {
              node {
                id
                title
                metafields(identifiers: [
                  { namespace: "sinflora", key: "seat_unit" },
                  { namespace: "sinflora", key: "seats_per_ticket" }
                ]) { key value }
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
// export const runtime = "nodejs"; // sbloccalo se mai vedessi limiti Edge

async function listAllBundleVariants(limit: number | null) {
  const variants: { id: string; seat: string; qty: number; title?: string | null }[] = [];
  let cursor: string | null = null;

  for (;;) {
    let data: ListResp;
    try {
      const raw = await adminFetchGQL(Q_LIST_BUNDLE_VARIANTS, { cursor });
      data = (raw as unknown) as ListResp;
    } catch (err: any) {
      throw new Error(`GraphQL fetch failed: ${String(err?.message || err)}`);
    }

    const edges = data?.products?.edges ?? [];
    for (const e of edges) {
      const vEdges = e?.node?.variants?.edges ?? [];
      for (const ve of vEdges) {
        const v = ve?.node;
        if (!v || !v.id) continue;

        const mfs = v.metafields ?? [];
        const seat = (mfs.find((m) => m?.key === "seat_unit")?.value ?? "") as string;
        const qtyStr = (mfs.find((m) => m?.key === "seats_per_ticket")?.value ?? "1") as string;
        const qty = Number.parseInt(qtyStr, 10) || 1;

        if (seat) variants.push({ id: v.id, seat, qty, title: v.title ?? null });

        if (limit && variants.length >= limit) return variants;
      }
    }

    const hasNext = Boolean(data?.products?.pageInfo?.hasNextPage);
    cursor = hasNext ? (edges[edges.length - 1]?.cursor ?? null) : null;
    if (!cursor) break;
  }
  return variants;
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

    const variants = await listAllBundleVariants(limit);

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        variantsFound: variants.length,
        sample: debug ? variants.slice(0, 3) : undefined,
      });
    }

    if (!variants.length) {
      return NextResponse.json({ ok: true, updated: 0, note: "No bundle variants found" });
    }

    let updated = 0;
    for (let i = 0; i < variants.length; i += 20) {
      const slice = variants.slice(i, i + 20).map((v) => ({
        parentProductVariantId: v.id,
        productVariantRelationshipsToRemove: [v.seat],
        productVariantRelationshipsToCreate: [{ id: v.seat, quantity: v.qty }],
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

    return NextResponse.json({ ok: true, updated });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
