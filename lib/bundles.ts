// lib/bundles.ts
// Helpers per creare/riusare Posti (Seat Unit) e Biglietti (Bundle) e collegare componenti.
// Allineato a Admin GraphQL 2024-07/2024-10
import {
  adminFetchGQL,
  getDefaultLocationId,
  publishProductToPublication,
  uploadFileFromUrl,
} from "@/lib/shopify-admin";

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
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
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
  createdProduct: boolean; // true se il prodotto Bundle è stato creato ora
  createdVariants: number; // quante varianti sono state create in questo giro
};

// --- Utils ---
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function buildSeatTitle(base: string, date: string, time: string) {
  return ${base} — ${date} ${time};
}
function buildBundleTitle(base: string, date: string, time: string) {
  const [y, m, d] = date.split("-");
  return ${base} — ${d}/${m}/${y} ${time};
}

// --- GQL snippets (version-agnostic per 2024-07/2024-10) ---
const Q_FIND_PRODUCT_BY_TITLE = /* GraphQL */ query FindProductByTitle($q: String!) {
  products(first: 1, query: $q) {
    edges {
      node {
        id
        title
        status
        templateSuffix
        tags
        variants(first: 20) {
          edges {
            node {
              id
              title
              selectedOptions { name value }
              inventoryItem { id }
            }
          }
        }
      }
    }
  }
} ;
const M_PRODUCT_CREATE = /* GraphQL */ mutation ProductCreate($input: ProductInput!) {
  productCreate(input: $input) {
    product {
      id
      title
      status
      templateSuffix
      tags
      variants(first: 20) {
        edges {
          node {
            id
            title
            selectedOptions { name value }
            inventoryItem { id }
          }
        }
      }
    }
    userErrors { field message }
  }
} ;
const Q_PRODUCT_BY_ID = /* GraphQL */ query ProductById($id: ID!) {
  product(id: $id) {
    id
    title
    status
    templateSuffix
    tags
    variants(first: 20) {
      edges {
        node {
          id
          title
          selectedOptions { name value }
          inventoryItem { id }
        }
      }
    }
  }
} ;
const M_PRODUCT_UPDATE = /* GraphQL */ mutation ProductUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id title status templateSuffix tags }
    userErrors { field message }
  }
} ;
const M_PRODUCT_VARIANTS_BULK_CREATE = /* GraphQL */ mutation PVBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
    productVariants {
      id
      title
      selectedOptions { name value }
    }
    userErrors { field message }
  }
} ;
const M_PRODUCT_VARIANT_RELATIONSHIP_BULK_UPDATE = /* GraphQL */ mutation PVRRelBulkUpdate($input: [ProductVariantRelationshipUpdateInput!]!) {
  productVariantRelationshipBulkUpdate(input: $input) {
    userErrors { field message }
  }
} ;
// Inventario: payload corretto (input = InventorySetQuantitiesInput!)
const M_INVENTORY_SET_QUANTITIES = /* GraphQL */ mutation InvSet($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup {
      createdAt reason referenceDocumentUri
      changes { name delta quantityAfterChange }
    }
    userErrors { field message }
  }
} ;
/* ---------- MEDIA: attach featured image ---------- */
const M_PRODUCT_CREATE_MEDIA = /* GraphQL */ mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media {
      ... on MediaImage { id image { url } }
    }
    mediaUserErrors { field message }
  }
} ;
const M_PRODUCT_SET_FEATURED = /* GraphQL */ mutation ProductSetFeatured($productId: ID!, $mediaId: ID!) {
  productSetFeaturedMedia(productId: $productId, mediaId: $mediaId) {
    product { id featuredMedia { id } }
    userErrors { field message }
  }
} ;
/* ---------- Tracking scorte (PATCH) ---------- */
const Q_VARIANT_ITEM = /* GraphQL */ query VariantItem($id: ID!) {
  productVariant(id: $id) {
    id
    inventoryItem { id }
  }
} ;
const M_INVENTORY_ITEM_UPDATE = /* GraphQL */ mutation InvItemUpdate($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem { id tracked }
    userErrors { field message }
  }
} ;
const M_PV_BULK_UPDATE_TRACK = /* GraphQL */ mutation PVBulkUpdateTrack($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
} ;
// Scrive/aggiorna metafield su vari owner (qui: varianti)
const M_METAFIELDS_SET = /* GraphQL */ mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message }
  }
} ;

// --- Funzioni di supporto interne ---
async function findProductByExactTitle(title: string, mustHaveTag?: string) {
  const parts = [title:"${title.replace(/"/g, '\\"')}"];
  if (mustHaveTag) parts.push(tag:${mustHaveTag});
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
// (tenuto per completezza, al momento non forzato qui)
function getOnlineStorePublicationIdOrThrow(): string {
  const id = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID;
  if (!id) {
    throw new Error(
      "SHOPIFY_ONLINE_STORE_PUBLICATION_ID mancante. Impostalo nelle Environment Variables Vercel."
    );
  }
  return id;
}
function getXmasAdminPublicationId(): string | undefined {
  return process.env.SHOPIFY_XMAS_ADMIN_PUBLICATION_ID || process.env.XMAS_ADMIN_PUBLICATION_ID || undefined;
}
async function publishProductToOnlineStore(productId: string, _pubId?: string) {
  if (_pubId) {
    await publishProductToPublication({ productId, publicationId: _pubId });
  } else {
    await publishProductToPublication({ productId });
  }
}
async function createProductActive(opts: {
  title: string;
  templateSuffix?: string;
  tags?: string[];
  descriptionHtml?: string;
  publishToPublicationId?: string;
  imageUrl?: string;
}) {
  const res = await adminFetchGQL<{ productCreate: { product?: any; userErrors: { message: string }[] } }>(
    M_PRODUCT_CREATE,
    {
      input: {
        title: opts.title,
        status: "ACTIVE",
        templateSuffix: opts.templateSuffix || undefined,
        tags: opts.tags || undefined,
        descriptionHtml: opts.descriptionHtml || undefined,
        images: opts.imageUrl ? [{ src: opts.imageUrl }] : undefined,
      },
    }
  );
  const errs = (res as any).productCreate?.userErrors || [];
  if (errs.length) throw new Error(productCreate error: ${errs.map((e: any) => e.message).join(" | ")});
  const product = (res as any).productCreate?.product;
  if (!product?.id) throw new Error("productCreate: product.id mancante");
  // 1) Pubblica Negozio online (default o ID passato)
  await publishProductToOnlineStore(product.id, opts.publishToPublicationId);
  // 2) Pubblica anche sul canale "Xmas Admin API v2" se configurato in ENV
  const xmasPubId = getXmasAdminPublicationId();
  if (xmasPubId) {
    await publishProductToPublication({ productId: product.id, publicationId: xmasPubId });
  }
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
    unico: undefined,
    adulto: undefined,
    bambino: undefined,
    handicap: undefined,
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

/* ------ helpers: inventory / featured image ------ */
async function getInventoryItemId(variantId: string): Promise<string> {
  const r = await adminFetchGQL<{ productVariant: { inventoryItem: { id: string } | null } }>(
    Q_VARIANT_ITEM,
    { id: variantId }
  );
  const invId = r?.productVariant?.inventoryItem?.id;
  if (!invId) throw new Error(inventoryItem non trovato per la variante ${variantId});
  return invId;
}
/**
 * Abilita/disabilita tracking sulle varianti:
 * - InventoryItem.tracked = tracks
 * - Variant.inventoryPolicy = DENY (se tracked) / CONTINUE (se non tracked)
 */
async function setVariantTracking(params: {
  productId: string;
  variantIds: string[];
  tracks: boolean; // true => tracked, false => not tracked
  policy?: "DENY" | "CONTINUE"; // default: DENY se tracks=true, CONTINUE se tracks=false
}) {
  const { productId, variantIds, tracks } = params;
  const policy = params.policy ?? (tracks ? "DENY" : "CONTINUE");
  if (!variantIds.length) return;
  // 1) Toggle tracked sull'InventoryItem
  for (const vid of variantIds) {
    const inventoryItemId = await getInventoryItemId(vid);
    const upd = await adminFetchGQL<{ inventoryItemUpdate: { userErrors?: { message: string }[] } }>(M_INVENTORY_ITEM_UPDATE, {
      id: inventoryItemId,
      input: { tracked: tracks }
    });
    const errs1 = (upd as any)?.inventoryItemUpdate?.userErrors ?? [];
    if (errs1.length) {
      throw new Error(inventoryItemUpdate error: ${errs1.map((e: any) => e.message).join(" | ")});
    }
  }
  // 2) Allinea inventoryPolicy sulla variante
  const variantsPayload = variantIds.map((id) => ({ id, inventoryPolicy: policy }));
  const r = await adminFetchGQL<{ productVariantsBulkUpdate: { userErrors?: { message: string }[] } }>(
    M_PV_BULK_UPDATE_TRACK,
    { productId, variants: variantsPayload }
  );
  const errs2 = (r as any)?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errs2.length) {
    throw new Error(productVariantsBulkUpdate(track) error: ${errs2.map((e: any) => e.message).join(" | ")});
  }
}

/* ------ helper: attach featured image al prodotto ------ */
async function attachFeaturedImage(productId: string, imageUrl: string) {
  try {
    // Non fa male provare a creare il file (se già presente/URL pubblico, si ignora l'errore)
    await uploadFileFromUrl(imageUrl, { contentType: "IMAGE" });
  } catch { // ignore
  }
  const createRes = await adminFetchGQL<{ productCreateMedia: { media?: { id: string }[]; mediaUserErrors?: { field?: string[]; message: string }[]; }; }>(M_PRODUCT_CREATE_MEDIA, {
    productId,
    media: [{ mediaContentType: "IMAGE", originalSource: imageUrl }],
  });
  const mErrs = (createRes?.productCreateMedia?.mediaUserErrors as { field?: string[]; message: string }[] | undefined) || [];
  if (mErrs.length) {
    const msg = mErrs.map((e: { message: string }) => e.message).join(" | ");
    throw new Error(productCreateMedia error: ${msg});
  }
  const mediaId = createRes?.productCreateMedia?.media?.[0]?.id;
  if (!mediaId) throw new Error("productCreateMedia: nessun media creato/collegato");
  const featRes = await adminFetchGQL<{ productSetFeaturedMedia: { userErrors?: { message: string }[] } }>(
    M_PRODUCT_SET_FEATURED,
    { productId, mediaId }
  );
  const fErrs = ((featRes as any)?.productSetFeaturedMedia?.userErrors as { message: string }[] | undefined) || [];
  if (fErrs.length) {
    const msg = fErrs.map((e: { message: string }) => e.message).join(" | ");
    throw new Error(productSetFeaturedMedia error: ${msg});
  }
}

// --- API pubbliche ---
/**
 * Crea/riusa il prodotto "Posto" (ACTIVE + pubblicato) con 1 sola variante.
 * Tracking: ON (inventario monitorato) + policy DENY.
 */
export async function ensureSeatUnit(input: EnsureSeatUnitInput): Promise<EnsureSeatUnitResult> {
  const seatTitle = buildSeatTitle(input.titleBase, input.date, input.time);
  const existing = await findProductByExactTitle(seatTitle, "SeatUnit");
  if (existing) {
    const variantId = existing.variants?.edges?.[0]?.node?.id;
    if (!variantId) throw new Error("Seat esistente ma senza variante");
    // Assicura tracking ON anche sugli esistenti
    await setVariantTracking({
      productId: existing.id,
      variantIds: [variantId],
      tracks: true,
      policy: "DENY",
    });
    return { productId: existing.id, variantId, created: false };
  }
  if (input.dryRun) {
    return {
      productId: "gid://shopify/Product/NEW_SEAT_DRYRUN",
      variantId: "gid://shopify/ProductVariant/NEW_SEAT_VARIANT_DRYRUN",
      created: false,
    };
  }
  const product = await createProductActive({
    title: seatTitle,
    templateSuffix: input.templateSuffix,
    tags: Array.from(new Set([...(input.tags || []), "SeatUnit"])),
    descriptionHtml: input.description || undefined,
  });
  // Leggi variante e abilita tracking
  const prodFull = await getProductById(product.id);
  const variantId = prodFull?.variants?.edges?.[0]?.node?.id;
  if (!variantId) throw new Error("Seat creato ma senza variante (post read-by-id)");
  await setVariantTracking({
    productId: product.id,
    variantIds: [variantId],
    tracks: true,
    policy: "DENY",
  });
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
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      set: { variantId: opts.variantId, locationId, name: "available", quantity: opts.quantity },
    };
  }
  const Q_VAR = /* GraphQL */ query VariantInv($id: ID!) {
    productVariant(id: $id) {
      id
      inventoryItem { id }
    }
  } ;
  const varData = await adminFetchGQL<{ productVariant: { inventoryItem: { id: string } | null } }>(Q_VAR, { id: opts.variantId });
  const inventoryItemId = varData.productVariant?.inventoryItem?.id;
  if (!inventoryItemId) throw new Error("inventoryItem non trovato per la variante");
  const gqlInput = {
    name: "available" as const,
    reason: "correction" as const,
    ignoreCompareQuantity: true,
    referenceDocumentUri: gid://sinflora-xmas/Generate/${Date.now()},
    quantities: [
      { inventoryItemId, locationId, quantity: opts.quantity, compareQuantity: null },
    ],
  };
  const res = await adminFetchGQL<{ inventorySetQuantities: { userErrors: { field: string[]; message: string }[] } }>(
    M_INVENTORY_SET_QUANTITIES,
    { input: gqlInput }
  );
  const errs = (res as any).inventorySetQuantities?.userErrors || [];
  if (errs.length) throw new Error(inventorySetQuantities error: ${errs.map((e: any) => e.message).join(" | ")});
  return { ok: true };
}

/**
 * Crea/riusa il prodotto "Bundle" (ACTIVE + pubblicato) e assicura le varianti richieste.
 * Tracking: OFF (non monitorato) + policy CONTINUE.
 */
export async function ensureBundle(input: EnsureBundleInput): Promise<EnsureBundleResult> {
  const title = buildBundleTitle(input.titleBase, input.date, input.time);
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
    // Tracking OFF/CONTINUE anche per gli esistenti
    const existingVariantIds = Object.values(current).filter(Boolean) as string[];
    if (existingVariantIds.length) {
      await setVariantTracking({
        productId: existing.id,
        variantIds: existingVariantIds,
        tracks: false,
        policy: "CONTINUE",
      });
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
      if (errs.length) throw new Error(variantsBulkCreate error: ${errs.map((e: any) => e.message).join(" | ")});
      const created = out.productVariantsBulkCreate.productVariants || [];
      const createdMap = mapVariantIdsFromNodes(created);
      // tracking OFF anche sulle nuove
      const newIds = created.map(v => v.id).filter(Boolean) as string[];
      if (newIds.length) {
        await setVariantTracking({
          productId: existing.id,
          variantIds: newIds,
          tracks: false,
          policy: "CONTINUE",
        });
      }
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
  if (input.dryRun) {
    const ret: Record<"unico" | "adulto" | "bambino" | "handicap", string | undefined> = {
      unico: "gid://shopify/ProductVariant/DRYRUN_UNICO",
      adulto: "gid://shopify/ProductVariant/DRYRUN_ADULTO",
      bambino: "gid://shopify/ProductVariant/DRYRUN_BAMBINO",
      handicap: "gid://shopify/ProductVariant/DRYRUN_HANDICAP",
    };
    if (input.mode === "unico") ret.adulto = ret.bambino = ret.handicap = undefined;
    return {
      productId: "gid://shopify/Product/NEW_BUNDLE_DRYRUN",
      variantMap: ret,
      createdProduct: false,
      createdVariants: 0
    };
  }
  // crea prodotto (ACTIVE + publish sui canali configurati)
  const product = await createProductActive({
    title,
    templateSuffix: input.templateSuffix,
    // ⬇️ SOLO i tag scelti in UI + "Bundle" (niente auto-tag col eventHandle)
    tags: Array.from(new Set([...(input.tags || []), "Bundle"])),
    descriptionHtml: input.description || undefined,
    imageUrl: undefined, // feature image la settiamo dopo via media
  });
  // attach featured image se presente
  if (input.image) {
    try {
      await attachFeaturedImage(product.id, input.image);
    } catch (err) {
      console.warn("attachFeaturedImage warning:", err);
    }
  }
  // varianti richieste
  const needed = variantNamesForMode(input.mode);
  const variants = needed.map((k) => ({ optionValues: [{ optionName: "Title", name: labelForVariant(k) }] }));
  const out = await adminFetchGQL<{ productVariantsBulkCreate: { productVariants?: any[]; userErrors: { message: string }[] } }>(
    M_PRODUCT_VARIANTS_BULK_CREATE,
    { productId: product.id, variants, strategy: "REMOVE_STANDALONE_VARIANT" }
  );
  const errs = (out as any).productVariantsBulkCreate?.userErrors || [];
  if (errs.length) throw new Error(variantsBulkCreate error: ${errs.map((e: any) => e.message).join(" | ")});
  // varianti create
  const created = out.productVariantsBulkCreate.productVariants || [];
  const ret = mapVariantIdsFromNodes(created);
  // Tracking OFF/CONTINUE sulle nuove varianti
  const createdIds = created.map(v => v.id).filter(Boolean) as string[];
  if (createdIds.length) {
    await setVariantTracking({
      productId: product.id,
      variantIds: createdIds,
      tracks: false,
      policy: "CONTINUE",
    });
  }
  // Se per qualsiasi motivo non arrivano le varianti, fallback: leggi per ID e applica tracking OFF
  if (!ret.unico && !ret.adulto && !ret.bambino && !ret.handicap) {
    const full = await getProductById(product.id);
    const edges = full?.variants?.edges?.map((e: any) => e.node) || [];
    const mapped = mapVariantIdsFromNodes(edges);
    const fallbackIds = edges.map((n: any) => n?.id).filter(Boolean) as string[];
    if (fallbackIds.length) {
      await setVariantTracking({
        productId: product.id,
        variantIds: fallbackIds,
        tracks: false,
        policy: "CONTINUE",
      });
    }
    return { productId: product.id, variantMap: mapped, createdProduct: true, createdVariants: needed.length };
  }
  return { productId: product.id, variantMap: ret, createdProduct: true, createdVariants: created.length };
}

/**
 * Aggiorna il prezzo di 1..n varianti (EURO).
 */
export async function setVariantPrices(
  productId: string,
  mapEuro: Record<string, number | undefined>
) {
  const variantsInput = Object.entries(mapEuro)
    .filter(([, eur]) => typeof eur === "number" && Number.isFinite(eur as number))
    .map(([id, eur]) => ({
      id,
      price: (eur as number).toFixed(2),
    }));
  const M = /* GraphQL */ mutation PVBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  } ;
  const r = await adminFetchGQL<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(M, {
    productId,
    variants: variantsInput,
  });
  const errs = (r as any).productVariantsBulkUpdate?.userErrors || [];
  if (errs.length) throw new Error(productVariantsBulkUpdate error: ${errs.map((e: any) => e.message).join(" | ")});
  return { ok: true };
}

/**
 * Collega un Seat Unit come componente di una variante Bundle
 * e scrive i metafield richiesti dal calendario.
 */
export async function ensureVariantLeadsToSeat(opts: {
  bundleVariantId: string;
  seatVariantId: string;
  componentQuantity?: number;
  dryRun?: boolean;
}) {
  const { bundleVariantId, seatVariantId, componentQuantity = 1, dryRun } = opts;
  if (dryRun) {
    return { ok: true, created: false, updated: false, qty: componentQuantity };
  }
  // helper: scrivi/aggiorna i due metafield lato variante Bundle
  async function upsertSeatMetafields() {
    await adminFetchGQL(M_METAFIELDS_SET, {
      metafields: [
        {
          ownerId: bundleVariantId,
          namespace: "sinflora",
          key: "seat_unit",
          type: "variant_reference", // riferimento a ProductVariant
          value: seatVariantId, // GID della variante SeatUnit
        },
        {
          ownerId: bundleVariantId,
          namespace: "sinflora",
          key: "seats_per_ticket",
          type: "number_integer", // 1 o 2
          value: String(componentQuantity),
        },
      ],
    });
  }
  // 1) Prova a creare la relationship
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
    await ensureVariantEventuallyVisible(bundleVariantId);
    await upsertSeatMetafields(); // dopo CREATE
    return { ok: true, created: true, updated: false, qty: componentQuantity };
  }
  // 2) Se esiste già, aggiorna la quantità della relationship
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
    await upsertSeatMetafields(); // dopo UPDATE
    return { ok: true, created: false, updated: true, qty: componentQuantity };
  }
  const all = [...errs, ...errs2].map((e) => e?.message || JSON.stringify(e)).join("; ");
  throw new Error(Shopify GQL errors (ensureVariantLeadsToSeat): ${all});
}
async function ensureVariantEventuallyVisible(variantId: string, tries = 5) {
  const Q = /* GraphQL */ query PV($id: ID!) {
    productVariant(id: $id) { id }
  } ;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await adminFetchGQL<{ productVariant: { id: string } | null }>(Q, { id: variantId });
      if (r?.productVariant?.id) return;
    } catch { // ignore
    }
    await delay(150 * (i + 1));
  }
  throw new Error(Variant not ready/visible: ${variantId});
}
