// app/api/admin/generator/apply/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

// --- Auth comune: header x-admin-secret o Authorization: Bearer ---
function isAuthorized(req: NextRequest) {
  const s1 = req.headers.get("x-admin-secret")?.trim() || "";
  const s2 = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return !!(process.env.ADMIN_SECRET && (s1 === process.env.ADMIN_SECRET || s2 === process.env.ADMIN_SECRET));
}

// --- Util: GID helper ---
function toGid(kind: "Product" | "ProductVariant" | "Collection" | "Location", id: string) {
  return id.startsWith("gid://") ? id : `gid://shopify/${kind}/${id}`;
}

// ----------------- Queries & Mutations -----------------

const QUERY_PRODUCT_BY_TITLE_TAG = /* GraphQL */ `
  query ProductByTitleTag($query: String!) {
    products(first: 1, query: $query) {
      edges { node { id title handle tags status } }
    }
  }
`;

const QUERY_PRODUCT_VARIANTS = /* GraphQL */ `
  query ProductVariants($id: ID!) {
    product(id: $id) {
      id
      title
      status
      options { id name values }
      variants(first: 100) {
        edges {
          node {
            id
            title
            selectedOptions { name value }
            inventoryItem { id tracked }
          }
        }
      }
    }
  }
`;

const MUT_PRODUCT_CREATE = /* GraphQL */ `
  mutation CreateProduct($input: ProductCreateInput!) {
    productCreate(input: $input) {
      product { id title handle status }
      userErrors { field message }
    }
  }
`;

const MUT_VARIANTS_BULK_CREATE = /* GraphQL */ `
  mutation BulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      product { id }
      productVariants { id title selectedOptions { name value } inventoryItem { id tracked } }
      userErrors { field message }
    }
  }
`;

const MUT_INVENTORY_ACTIVATE = /* GraphQL */ `
  mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
      inventoryLevel { id available }
      userErrors { field message }
    }
  }
`;

const MUT_INVENTORY_SET_QUANTITIES = /* GraphQL */ `
  mutation SetQty($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

const MUT_COLLECTION_ADD_PRODUCTS_V2 = /* GraphQL */ `
  mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProductsV2(id: $id, productIds: $productIds) {
      job { id }
      userErrors { field message }
    }
  }
`;

const QUERY_COLLECTION = /* GraphQL */ `
  query FindCollection($query: String!) {
    collections(first: 1, query: $query) {
      edges { node { id title handle } }
    }
  }
`;

// ----------------- Tipi plan -----------------
type PlanVariantMeta = { namespace: string; key: string; type: string; value: string };
type PlanSeatUnit = {
  product: { title: string; handle: string; tags: string[] };
  variant: {
    title: string;
    sku?: string;
    inventory?: {
      tracked?: boolean;
      continueSelling?: boolean;
      perLocation?: { locationId: string; available: number }[];
    };
  };
};
type PlanBundle = {
  product: { title: string; handle: string; tags: string[] };
  variants: { key?: string; title: string; seats_per_ticket: number; metafields: PlanVariantMeta[] }[];
};
type PlanItem = {
  date: string; time: string; capacity: number; locationId: string;
  seatUnit: PlanSeatUnit; bundle: PlanBundle;
};
type ApplyInput = {
  collection?: string; date?: string; namePrefix?: string;
  dryRun?: boolean; plan?: PlanItem[];
};

// ----------------- helpers -----------------
function qstr(v: string) { return `'${String(v || "").replace(/'/g, "\\'")}'`; }
function buildProductSearchQuery(title: string, tag?: string) {
  return tag ? `title:${qstr(title)} AND tag:${tag}` : `title:${qstr(title)}`;
}
function findVariantIdByTitle(variants: any[], title: string): any | null {
  return variants.find((v: any) => {
    if (v.title === title) return true;
    const so = v.selectedOptions || [];
    return !!so.find((o: any) => o.name === "Title" && o.value === title);
  }) || null;
}
function formatUserErrors(arr: any[] | undefined) {
  return (arr || []).map((e: any) => (e?.field ? `${e.field.join(".")}: ${e.message}` : e?.message)).join("; ");
}

// ----------------- ensure* -----------------
async function ensureProduct(title: string, handle: string, tag: string) {
  const query = buildProductSearchQuery(title, tag);
  const found = await adminFetchGQL<{ products: { edges: { node: { id: string } }[] } }>(QUERY_PRODUCT_BY_TITLE_TAG, { query });
  const node = found?.products?.edges?.[0]?.node;
  if (node?.id) return { id: node.id, created: false };

  const create = await adminFetchGQL<any>(MUT_PRODUCT_CREATE, { input: { title, handle, tags: [tag], status: "ACTIVE" } });
  const perr = create?.productCreate?.userErrors || [];
  if (perr.length) throw new Error(`productCreate(${tag}) userErrors: ${formatUserErrors(perr)}`);
  const pid = create?.productCreate?.product?.id;
  if (!pid) throw new Error(`productCreate(${tag}) failed: no product id`);
  return { id: pid, created: true };
}

async function ensureSeatUnitVariant(opts: {
  productId: string; time: string; sku?: string; capacity: number; locationGid: string;
}) {
  const { productId, time, sku, capacity, locationGid } = opts;

  const pv = await adminFetchGQL<any>(QUERY_PRODUCT_VARIANTS, { id: productId });
  const variants = pv?.product?.variants?.edges?.map((e: any) => e.node) || [];

  // esiste già → set absolute qty
  const existing = findVariantIdByTitle(variants, time);
  if (existing) {
    const inventoryItemId = existing.inventoryItem?.id;
    if (inventoryItemId) {
      const r = await adminFetchGQL<any>(MUT_INVENTORY_SET_QUANTITIES, {
        input: {
          name: "available",
          ignoreCompareQuantity: true,
          reason: "correction",
          referenceDocumentUri: "https://sinflora.app/apply/seatunit",
          quantities: [{ inventoryItemId, locationId: locationGid, quantity: capacity }],
        },
      });
      const errs = r?.inventorySetQuantities?.userErrors || [];
      if (errs.length) throw new Error(`inventorySetQuantities userErrors: ${formatUserErrors(errs)}`);
    }
    return { id: existing.id, inventoryItemId, created: false };
  }

  // crea variante
  const strategy = variants.length === 1 && (variants[0].title === "Default Title")
    ? "REMOVE_STANDALONE_VARIANT"
    : "DEFAULT";

  const bulk = await adminFetchGQL<any>(MUT_VARIANTS_BULK_CREATE, {
    productId,
    strategy,
    variants: [{
      optionValues: [{ name: time, optionName: "Title" }],
      inventoryItem: { tracked: true, sku: sku || undefined },
    }],
  });
  const errs = bulk?.productVariantsBulkCreate?.userErrors || [];
  if (errs.length) throw new Error(`variantsBulkCreate(seatUnit) userErrors: ${formatUserErrors(errs)}`);
  const created = bulk?.productVariantsBulkCreate?.productVariants?.[0];
  if (!created?.id) throw new Error("variantsBulkCreate(seatUnit) failed: no variant id");

  // attiva inventario
  const inventoryItemId = created.inventoryItem?.id;
  if (inventoryItemId) {
    const act = await adminFetchGQL<any>(MUT_INVENTORY_ACTIVATE, {
      inventoryItemId, locationId: locationGid, available: capacity,
    });
    const aerrs = act?.inventoryActivate?.userErrors || [];
    if (aerrs.length) throw new Error(`inventoryActivate userErrors: ${formatUserErrors(aerrs)}`);
  }

  return { id: created.id, inventoryItemId, created: true };
}

async function ensureBundleVariants(opts: {
  productId: string;
  variantsPlan: { title: string; seats_per_ticket: number; metafields: PlanVariantMeta[] }[];
}) {
  const { productId, variantsPlan } = opts;

  const pv = await adminFetchGQL<any>(QUERY_PRODUCT_VARIANTS, { id: productId });
  const existing = pv?.product?.variants?.edges?.map((e: any) => e.node) || [];

  const toCreate: any[] = [];
  const kept: { title: string; id: string }[] = [];

  for (const v of variantsPlan) {
    const hit = findVariantIdByTitle(existing, v.title);
    if (hit) {
      kept.push({ title: v.title, id: hit.id });
    } else {
      toCreate.push({
        optionValues: [{ name: v.title, optionName: "Title" }],
        inventoryItem: { tracked: false },
        metafields: v.metafields.map(m => ({
          namespace: m.namespace, key: m.key, type: m.type, value: m.value,
        })),
      });
    }
  }

  let created: { title: string; id: string }[] = [];
  if (toCreate.length) {
    const bulk = await adminFetchGQL<any>(MUT_VARIANTS_BULK_CREATE, {
      productId, variants: toCreate, strategy: "DEFAULT",
    });
    const errs = bulk?.productVariantsBulkCreate?.userErrors || [];
    if (errs.length) throw new Error(`variantsBulkCreate(bundle) userErrors: ${formatUserErrors(errs)}`);
    const news = bulk?.productVariantsBulkCreate?.productVariants || [];
    created = news.map((n: any) => ({ title: n.title, id: n.id }));
  }

  return { kept, created };
}

async function ensureBundleProduct(title: string, handle: string) {
  const found = await adminFetchGQL<any>(QUERY_PRODUCT_BY_TITLE_TAG, { query: buildProductSearchQuery(title, "Bundle") });
  const node = found?.products?.edges?.[0]?.node;
  if (node?.id) return { id: node.id, created: false };

  const create = await adminFetchGQL<any>(MUT_PRODUCT_CREATE, {
    input: { title, handle, tags: ["Bundle"], status: "ACTIVE" },
  });
  const errs = create?.productCreate?.userErrors || [];
  if (errs.length) throw new Error(`productCreate(bundle) userErrors: ${formatUserErrors(errs)}`);
  const id = create?.productCreate?.product?.id;
  if (!id) throw new Error("productCreate(bundle) failed: no product id");
  return { id, created: true };
}

async function addProductsToCollection(handleOrTitle: string, productIds: string[]) {
  if (!handleOrTitle || !productIds.length) return { ok: false, reason: "missing_args" };
  const q = `handle:${handleOrTitle} OR title:${qstr(handleOrTitle)}`;
  const c = await adminFetchGQL<any>(QUERY_COLLECTION, { query: q });
  const cid = c?.collections?.edges?.[0]?.node?.id;
  if (!cid) return { ok: false, reason: "collection_not_found" };

  const r = await adminFetchGQL<any>(MUT_COLLECTION_ADD_PRODUCTS_V2, { id: cid, productIds });
  const errs = r?.collectionAddProductsV2?.userErrors || [];
  return { ok: !errs.length, reason: formatUserErrors(errs) || null, id: cid };
}

// ----------------- CORS -----------------
function withCORS(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-secret");
  res.headers.append("Vary", "Origin");
  return res;
}
export function OPTIONS() {
  return withCORS(new NextResponse(null, { status: 204 }));
}

// ----------------- MAIN -----------------
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return withCORS(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
  }

  try {
    let body: ApplyInput | null = null;
    try { body = await req.json(); } catch { /* ignore */ }

    const dryRun = body?.dryRun !== false; // default: true
    const plan: PlanItem[] = Array.isArray(body?.plan) ? body!.plan : [];

    if (!plan.length) {
      return withCORS(NextResponse.json({ ok: false, error: "missing_plan", hint: "Passa il JSON 'plan' ottenuto dallo /plan" }, { status: 400 }));
    }

    const locationIdRaw = plan[0]?.locationId;
    if (!locationIdRaw) {
      return withCORS(NextResponse.json({ ok: false, error: "missing_locationId" }, { status: 400 }));
    }
    const locationGid = toGid("Location", locationIdRaw);

    const results: any[] = [];
    const bundleProductIds: string[] = [];

    for (const item of plan) {
      const seatTitle  = item.seatUnit.product.title;
      const seatHandle = item.seatUnit.product.handle;
      const bundleTitle  = item.bundle.product.title;
      const bundleHandle = item.bundle.product.handle;
      const capacity = item.capacity;
      const seatSku  = item.seatUnit.variant.sku || undefined;
      const time     = item.seatUnit.variant.title;

      if (dryRun) {
        results.push({
          slot: `${item.date} ${item.time}`,
          seatUnit: { productTitle: seatTitle, handle: seatHandle, variantTitle: time, capacity },
          bundle: { productTitle: bundleTitle, handle: bundleHandle, variants: item.bundle.variants.map(v => v.title) }
        });
        continue;
      }

      // --- ESECUZIONE REALE (con errori contestualizzati) ---
      const seatProd = await ensureProduct(seatTitle, seatHandle, "SeatUnit")
        .catch(e => { throw new Error(`slot ${item.date} ${item.time} — ensureProduct(SeatUnit): ${e.message || e}`); });

      const seatVar = await ensureSeatUnitVariant({
        productId: seatProd.id, time, sku: seatSku, capacity, locationGid,
      }).catch(e => { throw new Error(`slot ${item.date} ${item.time} — ensureSeatUnitVariant: ${e.message || e}`); });

      const bundleProd = await ensureBundleProduct(bundleTitle, bundleHandle)
        .catch(e => { throw new Error(`slot ${item.date} ${item.time} — ensureProduct(Bundle): ${e.message || e}`); });

      bundleProductIds.push(bundleProd.id);

      const variantsPlan = item.bundle.variants.map(v => ({
        title: v.title,
        seats_per_ticket: v.seats_per_ticket,
        metafields: v.metafields.map(mf => mf.key === "seat_unit" ? { ...mf, value: seatVar.id } : mf),
      }));

      const bundleVars = await ensureBundleVariants({
        productId: bundleProd.id, variantsPlan,
      }).catch(e => { throw new Error(`slot ${item.date} ${item.time} — ensureBundleVariants: ${e.message || e}`); });

      results.push({
        slot: `${item.date} ${item.time}`,
        seatUnit: { productId: seatProd.id, variantId: seatVar.id, created: seatVar.created },
        bundle: { productId: bundleProd.id, created: bundleProd.created, variants: { kept: bundleVars.kept, created: bundleVars.created } }
      });
    }

    // attach alla collection (best-effort)
    let collectionAttach: any = null;
    if (!dryRun && body?.collection && bundleProductIds.length) {
      collectionAttach = await addProductsToCollection(body.collection, bundleProductIds);
    }

    return withCORS(NextResponse.json({
      ok: true,
      dryRun,
      applied: !dryRun,
      count: results.length,
      collectionAttach,
      results,
    }));
  } catch (err: any) {
    // <-- NIENTE 500 VUOTI: ritorniamo messaggio chiaro
    const msg = String(err?.message || err);
    return withCORS(NextResponse.json({ ok: false, error: "apply_failed", message: msg }, { status: 500 }));
  }
}
