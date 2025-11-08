// app/api/admin/dedupe-upcoming/route.ts
import { NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

/** Tipi minimi per la risposta GraphQL */
type Metafield = { key?: string | null; value?: string | null } | null;
type VariantNode = { id: string; metafields?: Metafield[] | null } | null;
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

/** Query & Mutation */
const Q_LIST_BUNDLE_VARIANTS = /* GraphQL */ `
  query List($cursor: String) {
    products(first: 50, after: $cursor, query: "tag:Bundle status:ACTIVE") {
      edges {
        cursor
        node {
          id
          variants(first: 50) {
            edges {
              node {
                id
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

/** Utils */
async function listAllBundleVariants() {
  const variants: { id: string; seat: string; qty: number }[] = [];
  let cursor: string | null = null;

  for (;;) {
    // Cast esplicito per evitare l'implicit any
    const raw = await adminFetchGQL(Q_LIST_BUNDLE_VARIANTS, { cursor });
    const data = (raw as unknown) as ListResp;

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

        if (seat) variants.push({ id: v.id, seat, qty });
      }
    }

    const hasNext = Boolean(data?.products?.pageInfo?.hasNextPage);
    cursor = hasNext ? (edges[edges.length - 1]?.cursor ?? null) : null;
    if (!cursor) break;
  }

  return variants;
}

/** Route */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || req.headers.get("x-admin-secret") || "";
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = /^(1|true)$/i.test(url.searchParams.get("dryRun") || "");

  const variants = await listAllBundleVariants();
  if (!variants.length) {
    return NextResponse.json({ ok: true, updated: 0, note: "No bundle variants found" });
  }

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, variantsFound: variants.length });
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
}

/** (facoltativi) per evitare cache e forzare runtime Node */
export const dynamic = "force-dynamic";
// export const runtime = "nodejs";
