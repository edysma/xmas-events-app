// lib/bundles.ts
// Helpers per creare/riusare Posti (Seat Unit) e Biglietti (Bundle) e collegare componenti.
// Allineato a Admin GraphQL 2024-07/2024-10

import { adminFetchGQL, getDefaultLocationId } from "@/lib/shopify-admin";

// --- Tipi locali ---
export type DayType = "weekday" | "friday" | "saturday" | "sunday" | "holiday";
export type TicketMode = "unico" | "triple";

export type PriceTierEuro = {
  unico?: number;
  adulto?: number;
  bambino?: number;
  handicap?: number;
};

type EnsureSeatUnitInput = {
  titleBase: string; // es: "Seat Unit · Viaggio Incantato"
  date: string;      // YYYY-MM-DD
  time: string;      // HH:mm
  templateSuffix?: string;
  tags?: string[];
  description?: string | null;
  dryRun?: boolean;
};

type EnsureSeatUnitResult = {
  productId: string;
  variantId: string;
  created: boolean; // true se il Seat è stato creato ora
};

// attenzione: chi chiama può passare "priceTier€" nel payload runtime.
type EnsureBundleInput = {
  eventHandle: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  titleBase: string;
  dayType: DayType;
  mode: TicketMode;
  "priceTier€": PriceTierEuro; // in EURO
  templateSuffix?: string;
  image?: string | null;
  tags?: string[];
  description?: string | null;
  dryRun?: boolean;
};

type EnsureBundleResult = {
  productId: string;
  variantMap: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined>;
  createdProduct: boolean;   // true se il prodotto Bundle è stato creato ora
  createdVariants: number;   // quante varianti sono state create in questo giro
};

// --- Utils ---
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildSeatTitle(base: string, date: string, time: string) {
  // Titolo tecnico (nascosto) per i Posti -> formato ISO per evitare collisioni
  return `${base} — ${date} ${time}`; // es: Viaggio — 2025-12-05 11:00
}
function buildBundleTitle(base: string, date: string, time: string) {
  // Titolo visibile per i Biglietti -> formato DD/MM/YYYY per distinguerlo dai Seat
  const [y, m, d] = date.split("-");
  return `${base} — ${d}/${m}/${y} ${time}`; // es: Viaggio — 05/12/2025 11:00
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
          tags
          variants(first: 20) {
            edges { node { id title selectedOptions { name value } inventoryItem { id } } }
          }
        }
      }
    }
  }
`;

const M_PRODUCT_CREATE = /* GraphQL */ `
  mutation ProductCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title status templateSuffix tags variants(first: 20) { edges { node { id title selectedOptions { name value } inventoryItem { id } } } } }
      userErrors { field message }
    }
  }
`;

const Q_PRODUCT_BY_ID = /* GraphQL */ `
  query ProductById($id: ID!) {
    product(id: $id) {
      id
      title
      status
      templateSuffix
      tags
      variants(first: 20) {
        edges { node { id title selectedOptions { name value } inventoryItem { id } } }
      }
    }
  }
`;

const M_PRODUCT_UPDATE = /* GraphQL */ `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title status templateSuffix tags }
      userErrors { field message }
    }
  }
`;

const M_PRODUCT_VARIANTS_BULK_CREATE = /* GraphQL */ `
  mutation PVBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id title selectedOptions { name value } }
      userErrors { field message }
    }
  }
`;

const M_PRODUCT_VARIANT_RELATIONSHIP_BULK_UPDATE = /* GraphQL */ `
  mutation PVRRelBulkUpdate($input: [ProductVariantRelationshipUpdateInput!]!) {
    productVariantRelationshipBulkUpdate(input: $input) {
      userErrors { field message }
    }
  }
`;

// Inventario: payload corretto (input = InventorySetQuantitiesInput!)
const M_INVENTORY_SET_QUANTITIES = /* GraphQL */ `
  mutation InvSet($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        referenceDocumentUri
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors { field message }
    }
  }
`;

// Pubblicazione al canale "Negozio online"
const M_PUBLISHABLE_PUBLISH = /* GraphQL */ `
  mutation PublishOne($id: ID!, $publicationId: ID!) {
    publishablePublish(id: $id, input: { publicationId: $publicationId }) {
      publishable { id }
      userErrors { field message }
    }
  }
`;

// --- Funzioni di supporto interne ---
async function findProductByExactTitle(title: string, mustHaveTag?: string) {
  const parts = [`title:"${title.replace(/"/g, '\\"')}"`];
  if (mustHaveTag) parts.push(`tag:${mustHaveTag}`);
  const q = parts.join(" ");
  const data = await adminFetchGQL<{ products: { edges: any[] } }>(Q_FIND_PRODUCT_BY_TITLE, { q });
  const node = data?.products?.edges?.[0]?.node;
  if (!node) return null;
  if (mustHaveTag) {
    const tags: string[] = node.tags || [];
    if (!tags.includes(mustHaveTag)) return null;
  }
  return node;
}

// legge l'ID pubblicazione del canale "Negozio online" da ENV (impostato su Vercel)
function getOnlineStorePublicationIdOrThrow(): string {
  const id = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID;
  if (!id) {
    throw new Error(
      "SHOPIFY_ONLINE_STORE_PUBLICATION_ID mancante. Impostalo nelle Environment Variables Vercel."
    );
  }
  return id;
}

async function publishProductToOnlineStore(productId: string, pubId?: string) {
  const publicationId = pubId || getOnlineStorePublicationIdOrThrow();
  const res = await adminFetchGQL<{ publishablePublish: { userErrors?: { message: string }[] } }>(
    M_PUBLISHABLE_PUBLISH,
    { id: productId, publicationId }
  );
  const errs = (res as any).publishablePublish?.userErrors || [];
  if (errs.length) throw new Error(`publishablePublish error: ${errs.map((e: any) => e.message).join(" | ")}`);
}

async function createProductActive(opts: {
  title: string;
  templateSuffix?: string;
  tags?: string[];
  descriptionHtml?: string;
  publishToPublicationId?: string; // opzionale, se omesso legge da ENV
}) {
  // crea ACTIVE
  const res = await adminFetchGQL<{ productCreate: { product?: any; userErrors: { message: string }[] } }>(
    M_PRODUCT_CREATE,
    {
      input: {
        title: opts.title,
        status: "ACTIVE",
        templateSuffix: opts.templateSuffix || undefined,
        tags: opts.tags || undefined,
        descriptionHtml: opts.descriptionHtml || undefined,
      },
    }
  );
  const errs = (res as any).productCreate?.userErrors || [];
  if (errs.length) throw new Error(`productCreate error: ${errs.map((e: any) => e.message).join(" | ")}`);
  const product = (res as any).productCreate?.product;
  if (!product?.id) throw new Error("productCreate: product.id mancante");

  // pubblica al Negozio online
  await publishProductToOnlineStore(product.id, opts.publishToPublicationId);

  return product;
}

async function getProductById(id: string) {
  const data = await adminFetchGQL<{ product: any }>(Q_PRODUCT_BY_ID, { id });
  return data?.product;
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

function mapVariantIdsFromNodes(nodes: any[]): Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> {
  const ret: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
    unico: undefined, adulto: undefined, bambino: undefined, handicap: undefined,
  };
  for (const v of nodes) {
    const t = (v.selectedOptions?.[0]?.value || v.title || "").toLowerCase();
    if (t.includes("unico")) ret.unico = v.id;
    else if (t.includes("adulto")) ret.adulto = v.id;
    else if (t.includes("bambino")) ret.bambino = v.id;
    else if (t.includes("handicap")) ret.handicap = v.id;
  }
  return ret;
}

// --- API pubbliche ---

/**
 * Crea/riusa il prodotto "Posto" (ACTIVE + pubblicato) con 1 sola variante.
 */
export async function ensureSeatUnit(input: EnsureSeatUnitInput): Promise<EnsureSeatUnitResult> {
  const seatTitle = buildSeatTitle(input.titleBase, input.date, input.time);

  // 1) cerco per titolo esatto + tag SeatUnit
  const existing = await findProductByExactTitle(seatTitle, "SeatUnit");
  if (existing) {
    const variantId = existing.variants?.edges?.[0]?.node?.id;
    if (!variantId) throw new Error("Seat esistente ma senza variante");
    return { productId: existing.id, variantId, created: false };
  }

  // 2) se dryRun, ritorno placeholder
  if (input.dryRun) {
    return {
      productId: "gid://shopify/Product/NEW_SEAT_DRYRUN",
      variantId: "gid://shopify/ProductVariant/NEW_SEAT_VARIANT_DRYRUN",
      created: false, // in dry-run non creiamo davvero
    };
  }

  // 3) crea prodotto ACTIVE + pubblica
  const product = await createProductActive({
    title: seatTitle,
    templateSuffix: input.templateSuffix,
    tags: Array.from(new Set([...(input.tags || []), "SeatUnit"])),
    descriptionHtml: input.description || undefined,
  });

  // 4) leggi varianti per ID (niente refetch per titolo/tag)
  const prodFull = await getProductById(product.id);
  const variantId = prodFull?.variants?.edges?.[0]?.node?.id;
  if (!variantId) throw new Error("Seat creato ma senza variante (post read-by-id)");
  return { productId: product.id, variantId, created: true };
}

/**
 * Setta lo stock "available" assoluto sulla variante e location indicata.
 * Usa inventorySetQuantities con reason "correction".
 */
export async function ensureInventory(opts: {
  variantId: string;
  locationId?: string;
  quantity: number;
  dryRun?: boolean;
}) {
  const locationId = opts.locationId || (await getDefaultLocationId());

  // Dry-run: non scrive, ma torna anteprima utile
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
      productVariant(id: $id) { id inventoryItem { id } }
    }
  `;
  const varData = await adminFetchGQL<{ productVariant: { inventoryItem: { id: string } | null } }>(Q_VAR, { id: opts.variantId });
  const inventoryItemId = varData.productVariant?.inventoryItem?.id;
  if (!inventoryItemId) throw new Error("inventoryItem non trovato per la variante");

  // Input OGGETTO (InventorySetQuantitiesInput), non array
  const gqlInput = {
    name: "available" as const,
    reason: "correction" as const,
    ignoreCompareQuantity: true,
    referenceDocumentUri: `gid://sinflora-xmas/Generate/${Date.now()}`,
    quantities: [
      { inventoryItemId, locationId, quantity: opts.quantity, compareQuantity: null },
    ],
  };

  const res = await adminFetchGQL<{ inventorySetQuantities: { userErrors: { field: string[]; message: string }[] } }>(
    M_INVENTORY_SET_QUANTITIES,
    { input: gqlInput }
  );
  const errs = (res as any).inventorySetQuantities?.userErrors || [];
  if (errs.length) throw new Error(`inventorySetQuantities error: ${errs.map((e: any) => e.message).join(" | ")}`);

  return { ok: true };
}

/**
 * Crea/riusa il prodotto "Bundle" (ACTIVE + pubblicato) e assicura le varianti richieste
 * (modalità "unico" -> solo "Biglietto unico"; modalità "triple" -> Adulto/Bambino/Handicap).
 */
export async function ensureBundle(input: EnsureBundleInput): Promise<EnsureBundleResult> {
  const title = buildBundleTitle(input.titleBase, input.date, input.time);

  // 1) se già esiste, mappa le varianti per Title (filtrato su tag Bundle)
  const existing = await findProductByExactTitle(title, "Bundle");
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
      const variants = needed.map((k) => ({ optionValues: [{ optionName: "Title", name: labelForVariant(k) }] }));
      const out = await adminFetchGQL<{ productVariantsBulkCreate: { productVariants?: any[]; userErrors: { message: string }[] } }>(
        M_PRODUCT_VARIANTS_BULK_CREATE,
        { productId: existing.id, variants, strategy: "REMOVE_STANDALONE_VARIANT" }
      );
      const errs = (out as any).productVariantsBulkCreate?.userErrors || [];
      if (errs.length) throw new Error(`variantsBulkCreate error: ${errs.map((e: any) => e.message).join(" | ")}`);

      const created = out.productVariantsBulkCreate.productVariants || [];
      // unisci mappa esistente + create
      const createdMap = mapVariantIdsFromNodes(created);
      return {
        productId: existing.id,
        variantMap: {
          unico: current["unico"] ?? createdMap.unico,
          adulto: current["adulto"] ?? createdMap.adulto,
          bambino: current["bambino"] ?? createdMap.bambino,
          handicap: current["handicap"] ?? createdMap.handicap,
        },
        createdProduct: false,
        createdVariants: created.length,
      };
    }

    return {
      productId: existing.id,
      variantMap: {
        unico: current["unico"],
        adulto: current["adulto"],
        bambino: current["bambino"],
        handicap: current["handicap"],
      },
      createdProduct: false,
      createdVariants: 0,
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
    if (input.mode === "unico") ret.adulto = ret.bambino = ret.handicap = undefined;
    return { productId: "gid://shopify/Product/NEW_BUNDLE_DRYRUN", variantMap: ret, createdProduct: false, createdVariants: 0 };
  }

  // 3) crea prodotto ACTIVE + pubblica
  const product = await createProductActive({
    title,
    templateSuffix: input.templateSuffix,
    tags: Array.from(new Set([...(input.tags || []), "Bundle", input.eventHandle].filter(Boolean))),
    descriptionHtml: input.description || undefined,
  });

  // 4) crea varianti richieste
  const needed = variantNamesForMode(input.mode);
  const variants = needed.map((k) => ({ optionValues: [{ optionName: "Title", name: labelForVariant(k) }] }));

  const out = await adminFetchGQL<{ productVariantsBulkCreate: { productVariants?: any[]; userErrors: { message: string }[] } }>(
    M_PRODUCT_VARIANTS_BULK_CREATE,
    { productId: product.id, variants, strategy: "REMOVE_STANDALONE_VARIANT" }
  );
  const errs = (out as any).productVariantsBulkCreate?.userErrors || [];
  if (errs.length) throw new Error(`variantsBulkCreate error: ${errs.map((e: any) => e.message).join(" | ")}`);

  // 5) usa direttamente le varianti restituite (no refetch per titolo/tag)
  const created = out.productVariantsBulkCreate.productVariants || [];
  const ret = mapVariantIdsFromNodes(created);

  // Se per qualsiasi motivo non arrivano le varianti, fallback: leggi per ID
  if (!ret.unico && !ret.adulto && !ret.bambino && !ret.handicap) {
    const full = await getProductById(product.id);
    const edges = full?.variants?.edges?.map((e: any) => e.node) || [];
    const mapped = mapVariantIdsFromNodes(edges);
    return { productId: product.id, variantMap: mapped, createdProduct: true, createdVariants: needed.length };
  }

  return { productId: product.id, variantMap: ret, createdProduct: true, createdVariants: created.length };
}

/**
 * Aggiorna il prezzo di 1..n varianti (EURO).
 * Accetta mappa { variantId: prezzoEuro }.
 */
export async function setVariantPrices(
  productId: string,
  mapEuro: Record<string, number | undefined>
) {
  const variantsInput = Object.entries(mapEuro)
    .filter(([, eur]) => typeof eur === "number" && Number.isFinite(eur as number))
    .map(([id, eur]) => ({
      id,
      // Schema 2024-10: price come STRINGA decimale (niente currencyCode)
      price: (eur as number).toFixed(2),
    }));

  const M = /* GraphQL */ `
    mutation PVBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }
  `;

  const r = await adminFetchGQL<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(M, {
    productId,
    variants: variantsInput,
  });

  const errs = (r as any).productVariantsBulkUpdate?.userErrors || [];
  if (errs.length) throw new Error(`productVariantsBulkUpdate error: ${errs.map((e: any) => e.message).join(" | ")}`);
  return { ok: true };
}

/**
 * Collega un Seat Unit (seatVariantId) come componente di una variante Bundle (bundleVariantId).
 * Usa productVariantRelationshipBulkUpdate con:
 * - parentProductVariantId
 * - productVariantRelationshipsToCreate / ...ToUpdate
 */
export async function ensureVariantLeadsToSeat(opts: {
  bundleVariantId: string;       // variante del Bundle (parent)
  seatVariantId: string;         // variante del Seat Unit (component)
  componentQuantity?: number;    // default 1 (per Handicap passa 2 dal chiamante)
  dryRun?: boolean;
}) {
  const { bundleVariantId, seatVariantId, componentQuantity = 1, dryRun } = opts;

  if (dryRun) {
    // niente chiamate reali, ma ritorniamo una shape coerente
    return { ok: true, created: false, updated: false, qty: componentQuantity };
  }

  // 1) Prova a CREARE la relazione
  const createInput = [
    {
      parentProductVariantId: bundleVariantId,
      productVariantRelationshipsToCreate: [
        { id: seatVariantId, quantity: componentQuantity },
      ],
    },
  ];

  let res = await adminFetchGQL<{ productVariantRelationshipBulkUpdate: { userErrors?: { code?: string; field?: string[]; message: string }[] } }>(
    M_PRODUCT_VARIANT_RELATIONSHIP_BULK_UPDATE,
    { input: createInput }
  );
  const errs = res?.productVariantRelationshipBulkUpdate?.userErrors ?? [];
  if (!errs.length) {
    // opzionale: attendi visibilità
    await ensureVariantEventuallyVisible(bundleVariantId);
    return { ok: true, created: true, updated: false, qty: componentQuantity };
  }

  // 2) Se già esiste, fai UPDATE della quantità
  const updateInput = [
    {
      parentProductVariantId: bundleVariantId,
      productVariantRelationshipsToUpdate: [
        { id: seatVariantId, quantity: componentQuantity },
      ],
    },
  ];

  res = await adminFetchGQL<{ productVariantRelationshipBulkUpdate: { userErrors?: { code?: string; field?: string[]; message: string }[] } }>(
    M_PRODUCT_VARIANT_RELATIONSHIP_BULK_UPDATE,
    { input: updateInput }
  );
  const errs2 = res?.productVariantRelationshipBulkUpdate?.userErrors ?? [];
  if (!errs2.length) {
    await ensureVariantEventuallyVisible(bundleVariantId);
    return { ok: true, created: false, updated: true, qty: componentQuantity };
  }

  // 3) Ancora errore: esponi i messaggi
  const all = [...errs, ...errs2].map((e) => e?.message || JSON.stringify(e)).join("; ");
  throw new Error(`Shopify GQL errors (ensureVariantLeadsToSeat): ${all}`);
}

// Per alcune letture immediate, la nuova variante può non essere ancora "visibile". Attendi fino a 1.5s
async function ensureVariantEventuallyVisible(variantId: string, tries = 5) {
  const Q = /* GraphQL */ `
    query PV($id: ID!) {
      productVariant(id: $id) { id }
    }
  `;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await adminFetchGQL<{ productVariant: { id: string } | null }>(Q, { id: variantId });
      if (r?.productVariant?.id) return; // ok, esiste
    } catch {
      // ignora e riprova
    }
    await delay(150 * (i + 1)); // 150, 300, 600, 900, 1200, 1500 ms
  }
  throw new Error(`Variant not ready/visible: ${variantId}`);
}
