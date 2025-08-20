// lib/bundles.ts
// Scheletro helpers per generatore Seat Units + Bundles
// - include helper per conversione prezzi e formattazioni titoli
// - stubs per ensureSeatUnit, ensureInventory, ensureBundle, setVariantPrices, upsertBundleComponents
// - chiamate GQL pronte, ma usa i parametri dryRun per NON scrivere su Shopify quando non serve

import { adminFetchGQL, getDefaultLocationId } from "@/lib/shopify-admin";
import type { DayType, PriceTierEuro, TicketType } from "@/types/generate";

// ===================== Utils =====================
export function euroToCents(eur: number): number {
  // arrotonda a 2 decimali e converte in cent
  return Math.round(Number((eur ?? 0).toFixed(2)) * 100);
}

export function seatTitle(titleBase: string, date: string, time: string) {
  // Seat Unit (nascosto)
  return `${titleBase} — ${date} ${time}`;
}

export function bundleTitle(titleBase: string, date: string, time: string) {
  // Bundle (visibile)
  const [y, m, d] = date.split("-");
  return `${titleBase} — ${d}/${m}/${y} ${time}`;
}

export function variantNameFromTicketType(t: TicketType): string {
  if (t === "unico") return "Biglietto unico";
  if (t === "adulto") return "Adulto";
  if (t === "bambino") return "Bambino";
  if (t === "handicap") return "Handicap";
  return String(t);
}

// ===================== Shopify GraphQL fragments / queries =====================

// trova prodotto per titolo esatto
const Q_PRODUCT_BY_TITLE = /* GraphQL */ `
  query ProductByTitle($q: String!) {
    products(first: 1, query: $q) {
      edges {
        node {
          id
          title
          status
          variants(first: 10) {
            nodes { id title inventoryItem { id } }
          }
        }
      }
    }
  }
`;

// crea prodotto "seat" (nascosto: DRAFT)
const M_PRODUCT_CREATE = /* GraphQL */ `
  mutation ProductCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        title
        status
        variants(first: 1) { nodes { id title inventoryItem { id } } }
      }
      userErrors { field message }
    }
  }
`;

// create/ensure varianti: useremo productCreate per prima creazione; per aggiunte si può usare productVariantsBulkCreate
const M_PRODUCT_VARIANTS_BULK_CREATE = /* GraphQL */ `
  mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkCreateInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      product { id }
      userErrors { field message }
    }
  }
`;

// set prezzo variante
const M_PRODUCT_VARIANT_UPDATE = /* GraphQL */ `
  mutation ProductVariantUpdate($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant { id title price }
      userErrors { field message }
    }
  }
`;

// fetch inventoryItemId di una variante
const Q_VARIANT_INVENTORY_ITEM = /* GraphQL */ `
  query VariantInventoryItem($id: ID!) {
    productVariant(id: $id) {
      id
      inventoryItem { id }
    }
  }
`;

// set quantity su location
const M_INVENTORY_SET_QUANTITIES = /* GraphQL */ `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { code field message }
      inventoryLevels {
        name
        quantities { name quantity }
      }
    }
  }
`;

// bundle components
const M_PRODUCT_VARIANT_REL_BULK_UPDATE = /* GraphQL */ `
  mutation ProductVariantRelationshipBulkUpdate($operations: [ProductVariantRelationshipBulkUpdateOperationInput!]!) {
    productVariantRelationshipBulkUpdate(operations: $operations) {
      job {
        id
        done
      }
      userErrors { field message }
    }
  }
`;

// ===================== Core helpers (stubs pronti) =====================

export type EnsureSeatUnitInput = {
  date: string;           // YYYY-MM-DD
  time: string;           // HH:mm
  titleBase: string;
  tags?: string[];
  description?: string;   // HTML
  imageId?: string;       // opzionale: ID file Shopify già caricato
  templateSuffix?: string;// es: "seat"
  dryRun?: boolean;       // default true → non scrive
};

export type EnsureSeatUnitResult = {
  productId: string;
  variantId: string;
  created: boolean;
};

export async function ensureSeatUnit(input: EnsureSeatUnitInput): Promise<EnsureSeatUnitResult> {
  const dryRun = input.dryRun ?? true;
  const title = seatTitle(input.titleBase, input.date, input.time);
  // cerca per titolo esatto
  const q = `title:"${title.replace(/"/g, '\\"')}"`;
  const found = await adminFetchGQL<{ products: { edges: { node: any }[] } }>(Q_PRODUCT_BY_TITLE, { q });
  const node = found.products?.edges?.[0]?.node;
  if (node) {
    const variant = node.variants?.nodes?.[0];
    return { productId: node.id, variantId: variant?.id, created: false };
  }

  if (dryRun) {
    // simulazione: restituiamo id fittizi coerenti
    return {
      productId: "gid://shopify/Product/NEW_SEAT_DRYRUN",
      variantId: "gid://shopify/ProductVariant/NEW_SEAT_VAR_DRYRUN",
      created: true,
    };
  }

  // crea prodotto DRAFT con una sola variante
  const productInput: any = {
    title,
    status: "DRAFT",
    tags: input.tags?.join(", "),
    bodyHtml: input.description ?? undefined,
    templateSuffix: input.templateSuffix ?? undefined,
    // image non obbligatoria per i seat
  };

  const created = await adminFetchGQL<{
    productCreate: { product: any; userErrors: { field?: string[]; message: string }[] };
  }>(M_PRODUCT_CREATE, { input: productInput });

  const errs = created.productCreate?.userErrors ?? [];
  if (errs.length) {
    const msg = errs.map(e => e.message).join(" | ");
    throw new Error(`productCreate (seat) error: ${msg}`);
  }
  const prod = created.productCreate?.product;
  const var0 = prod?.variants?.nodes?.[0];
  return { productId: prod.id, variantId: var0?.id, created: true };
}

export type EnsureInventoryInput = {
  variantId: string;
  locationId?: string; // se omesso, getDefaultLocationId()
  quantity: number;    // stock desiderato (set)
  dryRun?: boolean;
};

export async function ensureInventory(input: EnsureInventoryInput): Promise<{ ok: true }> {
  const dryRun = input.dryRun ?? true;
  const locationId = input.locationId ?? (await getDefaultLocationId());

  if (dryRun) return { ok: true };

  // 1) prendi inventoryItemId
  const q = await adminFetchGQL<{ productVariant: { inventoryItem: { id: string } } }>(
    Q_VARIANT_INVENTORY_ITEM,
    { id: input.variantId }
  );
  const inventoryItemId = q.productVariant?.inventoryItem?.id;
  if (!inventoryItemId) throw new Error("inventoryItemId non trovato per la variante");

  // 2) set quantity
  const res = await adminFetchGQL<{
    inventorySetQuantities: { userErrors: { code?: string; field?: string[]; message: string }[] };
  }>(M_INVENTORY_SET_QUANTITIES, {
    input: {
      inventoryItemId,
      locationQuantities: [
        {
          locationId,
          quantities: [{ name: "AVAILABLE", quantity: input.quantity }],
        },
      ],
    },
  });

  const errs = res.inventorySetQuantities?.userErrors ?? [];
  if (errs.length) {
    const msg = errs.map(e => e.message).join(" | ");
    throw new Error(`inventorySetQuantities error: ${msg}`);
  }
  return { ok: true };
}

export type EnsureBundleInput = {
  eventHandle: string;
  date: string;              // YYYY-MM-DD
  time: string;              // HH:mm
  titleBase: string;
  templateSuffix?: string;
  tags?: string[];
  description?: string;
  imageId?: string;          // opzionale: ID file
  dayType: DayType;
  mode: "unico" | "triple";
  priceTier€: PriceTierEuro; // in EURO — conversione a cent verrà fatta in setVariantPrices
  dryRun?: boolean;
};

export type EnsureBundleResult = {
  productId: string;
  // mappa varianti create/riusate (id)
  variants: Partial<Record<TicketType, string>>;
  created: boolean;
};

// NB: questa funzione crea/riusa il prodotto bundle e assicura le varianti necessarie (senza collegare componenti)
export async function ensureBundle(input: EnsureBundleInput): Promise<EnsureBundleResult> {
  const dryRun = input.dryRun ?? true;
  const title = bundleTitle(input.titleBase, input.date, input.time);

  // check se esiste già
  const q = `title:"${title.replace(/"/g, '\\"')}"`;
  const found = await adminFetchGQL<{ products: { edges: { node: any }[] } }>(Q_PRODUCT_BY_TITLE, { q });
  const node = found.products?.edges?.[0]?.node;

  if (node) {
    // esiste: torniamo id + eventuali varianti già presenti
    const current: Partial<Record<TicketType, string>> = {};
    for (const v of node.variants?.nodes ?? []) {
      const name = (v.title || "").toLowerCase();
      if (name.includes("unico")) current["unico"] = v.id;
      if (name.includes("adulto")) current["adulto"] = v.id;
      if (name.includes("bambino")) current["bambino"] = v.id;
      if (name.includes("handicap")) current["handicap"] = v.id;
    }
    return { productId: node.id, variants: current, created: false };
  }

  if (dryRun) {
    // simulazione: restituiamo id fittizi coerenti
    const variants: Partial<Record<TicketType, string>> =
      input.mode === "unico"
        ? { unico: "gid://shopify/ProductVariant/DRYRUN_UNICO" }
        : {
            adulto: "gid://shopify/ProductVariant/DRYRUN_ADULTO",
            bambino: "gid://shopify/ProductVariant/DRYRUN_BAMBINO",
            handicap: "gid://shopify/ProductVariant/DRYRUN_HANDICAP",
          };

    return {
      productId: "gid://shopify/Product/NEW_BUNDLE_DRYRUN",
      variants,
      created: true,
    };
  }

  // Crea prodotto ACTIVE senza varianti custom (Shopify crea default), poi aggiungi varianti necessarie
  const created = await adminFetchGQL<{
    productCreate: { product: any; userErrors: { field?: string[]; message: string }[] };
  }>(M_PRODUCT_CREATE, {
    input: {
      title,
      status: "ACTIVE",
      templateSuffix: input.templateSuffix ?? undefined,
      tags: input.tags?.join(", "),
      bodyHtml: input.description ?? undefined,
      // image: gestibile in step successivo con uploadFileFromUrl
    },
  });

  const errs = created.productCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map(e => e.message).join(" | "));
  const productId = created.productCreate?.product?.id;
  if (!productId) throw new Error("productCreate (bundle): productId mancante");

  // Prepara varianti richieste
  const variantsToCreate: { title: string }[] =
    input.mode === "unico"
      ? [{ title: variantNameFromTicketType("unico") }]
      : [
          { title: variantNameFromTicketType("adulto") },
          { title: variantNameFromTicketType("bambino") },
          { title: variantNameFromTicketType("handicap") },
        ];

  if (variantsToCreate.length) {
    const bv = await adminFetchGQL<{
      productVariantsBulkCreate: { userErrors: { field?: string[]; message: string }[] };
    }>(M_PRODUCT_VARIANTS_BULK_CREATE, {
      productId,
      variants: variantsToCreate,
    });
    const verr = bv.productVariantsBulkCreate?.userErrors ?? [];
    if (verr.length) throw new Error(verr.map(e => e.message).join(" | "));
  }

  // ricarica il prodotto per ottenere gli id varianti
  const refreshed = await adminFetchGQL<{ products: { edges: { node: any }[] } }>(Q_PRODUCT_BY_TITLE, { q });
  const refNode = refreshed.products?.edges?.[0]?.node;
  const map: Partial<Record<TicketType, string>> = {};
  for (const v of refNode?.variants?.nodes ?? []) {
    const name = (v.title || "").toLowerCase();
    if (name.includes("unico")) map["unico"] = v.id;
    if (name.includes("adulto")) map["adulto"] = v.id;
    if (name.includes("bambino")) map["bambino"] = v.id;
    if (name.includes("handicap")) map["handicap"] = v.id;
  }

  return { productId, variants: map, created: true };
}

export async function setVariantPrices(params: {
  variantId: string;
  priceEuro: number;
  dryRun?: boolean;
}): Promise<{ ok: true }> {
  const dryRun = params.dryRun ?? t
