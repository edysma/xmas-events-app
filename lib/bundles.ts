// lib/bundles.ts
// Helpers per creare/riusare Posti (Seat Unit) e Biglietti (Bundle) e collegare componenti.
// Allineato a Admin GraphQL 2024-07/2024-10:
// - productVariantsBulkCreate variants: [ProductVariantsBulkInput!]!
// - productVariantRelationshipBulkUpdate input: [ProductVariantRelationshipUpdateInput!]!
// - inventorySetQuantities (name: "available", reason: "correction")

import { adminFetchGQL, getDefaultLocationId } from "@/lib/shopify-admin";

// --- Tipi locali (ASCII only) ---
export type DayType = "weekday" | "friday" | "saturday" | "sunday" | "holiday";
export type TicketMode = "unico" | "triple";

export type PriceTierEuro = {
  unico?: number;
  adulto?: number;
  bambino?: number;
  handicap?: number;
};

type EnsureSeatUnitInput = {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  titleBase: string;
  templateSuffix?: string;
  image?: string | null;
  tags?: string[];
  description?: string | null;
  dryRun?: boolean;
};

type EnsureSeatUnitResult = {
  productId: string;
  variantId: string;
};

// attenzione: chi chiama può passare "priceTier€" nel payload runtime.
// Qui la proprietà è quotata per evitare errori TS su "€".
type EnsureBundleInput = {
  eventHandle: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  titleBase: string;
  dayType: DayType;
  mode: TicketMode;
  "priceTier€": PriceTierEuro; // in EURO: conversione a cent nella setVariantPrices
  templateSuffix?: string;
  image?: string | null;
  tags?: string[];
  description?: string | null;
  dryRun?: boolean;
};

type EnsureBundleResult = {
  productId: string;
  variantMap: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined>;
};

// --- Utils ---
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const euroToCents = (v: number | undefined) =>
  typeof v === "number" ? Math.round(v * 100) : undefined;

function buildSeatTitle(base: string, date: string, time: string) {
  // titolo tecnico (nascosto) per i Posti
  return `${base} — ${date} ${time}`;
}
function buildBundleTitle(base: string, date: string, time: string) {
  // titolo visibile per i Biglietti
  // (manteniamo lo stesso formato, eventuale template del tema farà la resa)
  return `${base} — ${date} ${time}`;
}

// --- GQL snippets (version-agnostic per 2024-07/2024-10) ---
const Q_FIND_PRODUCT_BY_TITLE = /* GraphQL */ `
  query FindProductByTitle($q: String!) {
    products(first: 1, query: $q) {
      edges {
        node {
          id
          title
          status
          templateSuffix
          variants(first: 10) {
            edges { node { id title selectedOptions { name value } inventoryItem { id } } }
          }
        }
      }
    }
  }
`;

const M_PRODUCT_CREATE = /* GraphQL */ `
  mutation CreateProduct($input: ProductCreateInput!) {
    productCreate(input: $input) {
      product { id title status templateSuffix variants(first: 5) { edges { node { id title } } } }
      userErrors { field message }
    }
  }
`;

// Nota: usare ProductVariantsBulkInput (NON "...CreateInput")
const M_PRODUCT_VARIANTS_BULK_CREATE = /* GraphQL */ `
  mutation VariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id title selectedOptions { name value } }
      userErrors { field message }
    }
  }
`;

const M_PRODUCT_VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation VariantsBulkUpdate($variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(variants: $variants) {
      productVariants { id title price }
      userErrors { field message }
    }
  }
`;

// Bundles — aggiunge componenti (child variants) al parent variant
const M_VARIANT_REL_BULK_UPDATE = /* GraphQL */ `
  mutation BundleUpsert($input: [ProductVariantRelationshipUpdateInput!]!) {
    productVariantRelationshipBulkUpdate(input: $input) {
      parentProductVariants {
        id
        productVariantComponents(first: 50) {
          nodes { id productVariant { id } }
        }
      }
      userErrors { code field message }
    }
  }
`;

// Inventario: set assoluto "available" con reason "correction"
const M_INVENTORY_SET_QUANTITIES = /* GraphQL */ `
  mutation SetQty($input: [InventorySetQuantityInput!]!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes {
          name
          delta
          quantityAfterChange
          item { id }
          location { id }
        }
      }
      userErrors { field message }
    }
  }
`;

// --- Funzioni di supporto interne ---
async function findProductByExactTitle(title: string) {
  const q = `title:"${title.replace(/"/g, '\\"')}"`;
  const data = await adminFetchGQL<{
    products: { edges: { node: any }[] };
  }>(Q_FIND_PRODUCT_BY_TITLE, { q });
  return data.products.edges[0]?.node ?? null;
}

async function createProductDraft(params: {
  title: string;
  templateSuffix?: string;
  tags?: string[];
  descriptionHtml?: string | null;
}) {
  const input: any = {
    title: params.title,
    status: "DRAFT",
  };
  if (params.templateSuffix) input.templateSuffix = params.templateSuffix;
  if (params.tags?.length) input.tags = params.tags.join(", ");
  if (params.descriptionHtml) input.descriptionHtml = params.descriptionHtml;

  const res = await adminFetchGQL<{
    productCreate: {
      product?: any;
      userErrors: { field?: string[]; message: string }[];
    };
  }>(M_PRODUCT_CREATE, { input });

  const errs = res.productCreate.userErrors;
  if (errs?.length) throw new Error(`productCreate error: ${errs.map(e => e.message).join(" | ")}`);
  const product = res.productCreate.product;
  if (!product?.id) throw new Error("productCreate: prodotto non creato");
  return product;
}

function variantNamesForMode(mode: TicketMode): Array<"unico" | "adulto" | "bambino" | "handicap"> {
  return mode === "unico" ? ["unico"] : ["adulto", "bambino", "handicap"];
}

function labelForVariant(k: "unico" | "adulto" | "bambino" | "handicap") {
  if (k === "unico") return "Biglietto unico";
  if (k === "adulto") return "Adulto";
  if (k === "bambino") return "Bambino";
  return "Handicap";
}

// --- API pubbliche ---

/**
 * Crea/riusa il prodotto "Posto" (nascosto/draft) con 1 sola variante.
 */
export async function ensureSeatUnit(input: EnsureSeatUnitInput): Promise<EnsureSeatUnitResult> {
  const seatTitle = buildSeatTitle(input.titleBase, input.date, input.time);

  // 1) cerco per titolo esatto
  const existing = await findProductByExactTitle(seatTitle);
  if (existing) {
    const variantId = existing.variants?.edges?.[0]?.node?.id;
    if (!variantId) throw new Error("Seat esistente ma senza variante");
    return { productId: existing.id, variantId };
  }

  // 2) se dryRun, ritorno placeholder
  if (input.dryRun) {
    return {
      productId: "gid://shopify/Product/NEW_SEAT_DRYRUN",
      variantId: "gid://shopify/ProductVariant/NEW_SEAT_VARIANT_DRYRUN",
    };
  }

  // 3) crea prodotto draft
  const product = await createProductDraft({
    title: seatTitle,
    templateSuffix: input.templateSuffix,
    tags: Array.from(new Set([...(input.tags || []), "SeatUnit"])),
    descriptionHtml: input.description || undefined,
  });

  // productCreate crea una "Default Title" variant automaticamente
  const variantId = product.variants?.edges?.[0]?.node?.id;
  if (!variantId) throw new Error("Seat creato ma senza variante");
  return { productId: product.id, variantId };
}

/**
 * Setta lo stock "available" assoluto sulla variante e location indicata.
 * Usa inventorySetQuantities con reason "correction".
 */
export async function ensureInventory(opts: {
  variantId: string;
  locationId?: string;
  quantity: number;
  dryRun?: boolean; // <— aggiunto per compat con route.ts
}) {
  const locationId = opts.locationId || (await getDefaultLocationId());

  // Dry-run: non scrive nulla, ma torna subito
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      set: { variantId: opts.variantId, locationId, name: "available", quantity: opts.quantity },
    };
  }

  // Per inventorySetQuantities serve l'inventoryItemId
  const Q_VAR = /* GraphQL */ `
    query VariantInv($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem { id }
      }
    }
  `;
  const varData = await adminFetchGQL<{ productVariant: { inventoryItem: { id: string } | null } }>(
    Q_VAR,
    { id: opts.variantId }
  );
  const inventoryItemId = varData.productVariant?.inventoryItem?.id;
  if (!inventoryItemId) throw new Error("inventoryItem non trovato per la variante");

  const input = [
    {
      inventoryItemId,
      locationId,
      name: "available",
      reason: "correction",
      quantity: opts.quantity,
      ignoreCompareQuantity: true,
    },
  ];

  const res = await adminFetchGQL<{
    inventorySetQuantities: {
      userErrors: { field?: string[]; message: string }[];
    };
  }>(M_INVENTORY_SET_QUANTITIES, { input });

  const errs = (res as any).inventorySetQuantities?.userErrors || [];
  if (errs.length) throw new Error(`inventorySetQuantities error: ${errs.map((e: any) => e.message).join(" | ")}`);
}


/**
 * Crea/riusa il prodotto "Biglietto" e le sue varianti in base al mode.
 * Ritorna la mappa variantId per "unico"/"adulto"/"bambino"/"handicap".
 */
export async function ensureBundle(input: EnsureBundleInput): Promise<EnsureBundleResult> {
  const title = buildBundleTitle(input.titleBase, input.date, input.time);

  // 1) se già esiste, mappa le varianti per Title
  const existing = await findProductByExactTitle(title);
  if (existing) {
    const current: Record<string, string | undefined> = {};
    const edges = existing.variants?.edges || [];
    for (const e of edges) {
      const v = e.node;
      const so = v.selectedOptions || [];
      const t = (so.find((o: any) => o.name === "Title")?.value || v.title || "").toLowerCase();
      if (t.includes("unico")) current["unico"] = v.id;
      else if (t.includes("adulto")) current["adulto"] = v.id;
      else if (t.includes("bambino")) current["bambino"] = v.id;
      else if (t.includes("handicap")) current["handicap"] = v.id;
    }
    // se mancano varianti richieste, le aggiungo
    const needed = variantNamesForMode(input.mode).filter((k) => !current[k]);
    if (needed.length && !input.dryRun) {
      const variants = needed.map((k) => ({
        optionValues: [{ optionName: "Title", name: labelForVariant(k) }],
      }));
      const out = await adminFetchGQL<{
        productVariantsBulkCreate: { userErrors: { message: string }[] };
      }>(M_PRODUCT_VARIANTS_BULK_CREATE, {
        productId: existing.id,
        variants,
        strategy: "REMOVE_STANDALONE_VARIANT",
      });
      const errs = (out as any).productVariantsBulkCreate?.userErrors || [];
      if (errs.length) throw new Error(`variantsBulkCreate error: ${errs.map((e: any) => e.message).join(" | ")}`);

      // rileggi per ottenere gli ID aggiornati
      const refreshed = await findProductByExactTitle(title);
      const ret: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
        unico: undefined,
        adulto: undefined,
        bambino: undefined,
        handicap: undefined,
      };
      for (const e of refreshed?.variants?.edges || []) {
        const v = e.node;
        const t = (v.selectedOptions?.[0]?.value || v.title || "").toLowerCase();
        if (t.includes("unico")) ret.unico = v.id;
        else if (t.includes("adulto")) ret.adulto = v.id;
        else if (t.includes("bambino")) ret.bambino = v.id;
        else if (t.includes("handicap")) ret.handicap = v.id;
      }
      return { productId: refreshed.id, variantMap: ret };
    }

    return {
      productId: existing.id,
      variantMap: {
        unico: current["unico"],
        adulto: current["adulto"],
        bambino: current["bambino"],
        handicap: current["handicap"],
      },
    };
  }

  // 2) se dryRun, ritorno placeholder mappa
  if (input.dryRun) {
    const ret: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
      unico: "gid://shopify/ProductVariant/DRYRUN_UNICO",
      adulto: "gid://shopify/ProductVariant/DRYRUN_ADULTO",
      bambino: "gid://shopify/ProductVariant/DRYRUN_BAMBINO",
      handicap: "gid://shopify/ProductVariant/DRYRUN_HANDICAP",
    };
    if (input.mode === "unico") {
      ret.adulto = ret.bambino = ret.handicap = undefined;
    }
    return {
      productId: "gid://shopify/Product/NEW_BUNDLE_DRYRUN",
      variantMap: ret,
    };
  }

  // 3) crea prodotto (draft). La pubblicazione canale non è gestita qui (manca scope write_publications).
  const product = await createProductDraft({
    title,
    templateSuffix: input.templateSuffix,
    tags: Array.from(new Set([...(input.tags || []), "Bundle", input.eventHandle].filter(Boolean))),
    descriptionHtml: input.description || undefined,
  });

  // 4) crea varianti richieste
  const needed = variantNamesForMode(input.mode);
  const variants = needed.map((k) => ({
    optionValues: [{ optionName: "Title", name: labelForVariant(k) }],
  }));

  const out = await adminFetchGQL<{
    productVariantsBulkCreate: { userErrors: { message: string }[] };
  }>(M_PRODUCT_VARIANTS_BULK_CREATE, {
    productId: product.id,
    variants,
    strategy: "REMOVE_STANDALONE_VARIANT",
  });
  const errs = (out as any).productVariantsBulkCreate?.userErrors || [];
  if (errs.length) throw new Error(`variantsBulkCreate error: ${errs.map((e: any) => e.message).join(" | ")}`);

  // 5) rileggi per mappa ID
  const refreshed = await findProductByExactTitle(title);
  const ret: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
    unico: undefined,
    adulto: undefined,
    bambino: undefined,
    handicap: undefined,
  };
  for (const e of refreshed?.variants?.edges || []) {
    const v = e.node;
    const t = (v.selectedOptions?.[0]?.value || v.title || "").toLowerCase();
    if (t.includes("unico")) ret.unico = v.id;
    else if (t.includes("adulto")) ret.adulto = v.id;
    else if (t.includes("bambino")) ret.bambino = v.id;
    else if (t.includes("handicap")) ret.handicap = v.id;
  }
  return { productId: refreshed.id, variantMap: ret };
}

/**
 * Aggiorna il prezzo di 1..n varianti (EURO -> cent effettivi lato Shopify).
 * Accetta mappa { variantId: prezzoEuro }.
 */
export async function setVariantPrices(mapEuro: Record<string, number | undefined>) {
  const variantsInput = Object.entries(mapEuro)
    .filter(([, eur]) => typeof eur === "number")
    .map(([id, eur]) => ({
      id,
      price: (eur as number).toString(), // Admin GraphQL accetta string o decimal
    }));

  if (!variantsInput.length) return;

  const res = await adminFetchGQL<{
    productVariantsBulkUpdate: { userErrors: { field?: string[]; message: string }[] };
  }>(M_PRODUCT_VARIANTS_BULK_UPDATE, { variants: variantsInput });

  const errs = (res as any).productVariantsBulkUpdate?.userErrors || [];
  if (errs.length) throw new Error(`variantsBulkUpdate error: ${errs.map((e: any) => e.message).join(" | ")}`);
}

/**
 * Collega la variante "bundle" (parentVariantId) alla variante "seat" (child) con qty desiderata.
 * Per Handicap usare qty=2.
 */
export async function upsertBundleComponents(params: {
  parentVariantId: string;
  childVariantId: string;
  qty: number;
}) {
  const input = [
    {
      parentProductVariantId: params.parentVariantId,
      productVariantRelationshipsToCreate: [
        {
          id: params.childVariantId,
          quantity: params.qty,
        },
      ],
    },
  ];

  const res = await adminFetchGQL<{
    productVariantRelationshipBulkUpdate: { userErrors: { code?: string; message: string }[] };
  }>(M_VARIANT_REL_BULK_UPDATE, { input });

  const errs = (res as any).productVariantRelationshipBulkUpdate?.userErrors || [];
  if (errs.length) throw new Error(`bundle components error: ${errs.map((e: any) => e.message).join(" | ")}`);
}
