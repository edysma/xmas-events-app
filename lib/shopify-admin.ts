// lib/shopify-admin.ts
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2024-07";

function requiredEnv(name: string): string {
  const v =
    process.env[name as keyof NodeJS.ProcessEnv] ??
    (undefined as unknown as string);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const SHOP_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOP_DOMAIN || "";
const ADMIN_ACCESS_TOKEN = requiredEnv("ADMIN_ACCESS_TOKEN");

// Se vuoi rendere opzionale la pubblicazione, NON usare requiredEnv qui.
// Lo rendiamo facoltativo, ma la publish() fallirà con errore parlante se manca.
const ONLINE_STORE_PUBLICATION_ID =
  process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID || "";

if (!SHOP_DOMAIN) {
  throw new Error(
    "Missing env: SHOPIFY_STORE_DOMAIN (o SHOP_DOMAIN in fallback)"
  );
}

const ADMIN_BASE = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}`;
const GQL_URL = `${ADMIN_BASE}/graphql.json`;

// -------------------- Core GQL --------------------
type GqlResponse<T> = {
  data?: T;
  errors?: { message: string; locations?: any; path?: string[] }[];
};

export async function adminFetchGQL<T = any>(
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify GQL HTTP ${res.status}: ${text}`);
  }

  let json: GqlResponse<T>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Shopify: ${text.slice(0, 200)}...`);
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join(" | ");
    throw new Error(`Shopify GQL errors: ${msg}`);
  }

  if (!json.data) {
    throw new Error("Shopify GQL: empty data");
  }

  return json.data;
}

// -------------------- Core REST (per Themes) --------------------
export async function adminFetchREST<T = any>(
  path: string,
  init?: RequestInit & { searchParams?: Record<string, string> }
): Promise<T> {
  const url = new URL(`${ADMIN_BASE}${path}`);
  const sp = init?.searchParams;
  if (sp) {
    for (const [k, v] of Object.entries(sp)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN,
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify REST ${res.status}: ${text}`);
  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    return text as unknown as T;
  }
}

// -------------------- Utils --------------------
function toGid(kind: "Location", id: string): string {
  if (id.startsWith(`gid://shopify/${kind}/`)) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/${kind}/${id}`;
  return id;
}

// -------------------- Locations --------------------
export async function getDefaultLocationId(): Promise<string> {
  const fromEnv = process.env.DEFAULT_LOCATION_ID;
  if (fromEnv) return toGid("Location", fromEnv);

  const q = /* GraphQL */ `
    query GetOneLocation {
      locations(first: 1) {
        edges { node { id name } }
      }
    }
  `;
  const data = await adminFetchGQL<{
    locations: { edges: { node: { id: string; name: string } }[] };
  }>(q);

  const loc = data.locations?.edges?.[0]?.node?.id;
  if (!loc) throw new Error("Nessuna location trovata su Shopify");
  return loc; // es: gid://shopify/Location/123456789
}

// -------------------- Metafield: Festivi (custom.public_holidays) --------------------
/**
 * Legge il metafield shop custom.public_holidays e ritorna un array di date "YYYY-MM-DD".
 * Supporta:
 *  - value JSON array: ["2025-12-08","2025-12-25"]
 *  - value CSV: "2025-12-08,2025-12-25"
 *  - value stringa singola
 */
export async function getShopPublicHolidays(): Promise<string[]> {
  const q = /* GraphQL */ `
    query ShopHolidays {
      shop {
        metafield(namespace: "custom", key: "public_holidays") {
          type
          value
        }
      }
    }
  `;
  const data = await adminFetchGQL<{
    shop: { metafield: { type: string; value: string } | null };
  }>(q);

  const mf = data.shop?.metafield;
  if (!mf?.value) return [];

  // prova JSON prima
  try {
    const arr = JSON.parse(mf.value);
    if (Array.isArray(arr)) {
      return arr.map((s) => String(s)).filter(Boolean);
    }
  } catch {
    // non JSON
  }

  // fallback CSV o stringa singola
  if (mf.value.includes(",")) {
    return mf.value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [mf.value.trim()].filter(Boolean);
}

// -------------------- Themes: lista templates product.*.json --------------------
/**
 * Restituisce l'ID del tema principale e la lista delle chiavi degli asset
 * dei template prodotto (templates/product*.json).
 */
export async function listThemeProductTemplates(): Promise<{
  themeId: number;
  templateKeys: string[];
}> {
  // 1) lista temi
  const themes = await adminFetchREST<{ themes: { id: number; role: string }[] }>(
    `/themes.json`
  );
  if (!themes?.themes?.length) throw new Error("Nessun tema trovato");

  const main = themes.themes.find((t) => t.role === "main") ?? themes.themes[0];
  const themeId = main.id;

  // 2) lista assets del tema
  const assets = await adminFetchREST<{ assets: { key: string }[] }>(
    `/themes/${themeId}/assets.json`
  );
  const templateKeys =
    assets.assets
      ?.map((a) => a.key)
      .filter((k) => k.startsWith("templates/product") && k.endsWith(".json")) ?? [];

  return { themeId, templateKeys };
}

// -------------------- Files: upload da URL (write_files) --------------------
/**
 * Carica un file (immagine o generico) nella sezione Files di Shopify partendo da una URL esterna.
 * Richiede scope: write_files (opzionalmente read_files).
 * contentType: "IMAGE" | "FILE" (default "IMAGE")
 * Ritorna l'ID del file creato.
 */
export async function uploadFileFromUrl(
  originalSource: string,
  opts?: { alt?: string; contentType?: "IMAGE" | "FILE" }
): Promise<string> {
  const contentType = opts?.contentType ?? "IMAGE";
  const alt = opts?.alt ?? null;

  const m = /* GraphQL */ `
    mutation FileCreate($files: [FileCreateInput!]!] {
      fileCreate(files: $files) {
        files {
          id
          alt
          __typename
          ... on MediaImage { id image { url } }
          ... on GenericFile { id url }
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    files: [
      {
        originalSource,
        alt,
        contentType,
      },
    ],
  };

  const data = await adminFetchGQL<{
    fileCreate: {
      files: { id: string }[];
      userErrors: { field?: string[]; message: string }[];
    };
  }>(m, variables);

  const errors = data.fileCreate?.userErrors ?? [];
  if (errors.length) {
    const msg = errors.map((e) => e.message).join(" | ");
    throw new Error(`fileCreate error: ${msg}`);
  }

  const id = data.fileCreate?.files?.[0]?.id;
  if (!id) throw new Error("fileCreate: nessun file creato");
  return id;
}

// -------------------- Publish helpers (Online Store) --------------------
/**
 * Pubblica un Product su una Publication (Online Store).
 * NOTA: usa publishablePublish con frammento inline su Product.
 */
export async function publishProductToPublication(opts: {
  productId: string;           // gid://shopify/Product/...
  publicationId?: string;      // se omesso usa SHOPIFY_ONLINE_STORE_PUBLICATION_ID
}): Promise<{ ok: true }> {
  const publicationId = opts.publicationId || ONLINE_STORE_PUBLICATION_ID;
  if (!publicationId) {
    throw new Error(
      "Missing env SHOPIFY_ONLINE_STORE_PUBLICATION_ID: impossibile pubblicare il prodotto"
    );
  }

  const M = /* GraphQL */ `
    mutation PublishProduct($id: ID!, $pubId: ID!) {
      publishablePublish(id: $id, input: { publicationId: $pubId }) {
        publishable {
          __typename
          ... on Product { id }
        }
        userErrors { field message }
      }
    }
  `;

  const data = await adminFetchGQL<{
    publishablePublish: {
      publishable?: { __typename: string } | null;
      userErrors?: { field?: string[]; message: string }[];
    };
  }>(M, { id: opts.productId, pubId: publicationId });

  const errs = data.publishablePublish?.userErrors ?? [];
  if (errs.length) {
    const msg = errs.map((e) => e.message).join(" | ");
    throw new Error(`publishablePublish error: ${msg}`);
  }

  // Facoltativo: potremmo verificare __typename === "Product"
  return { ok: true };
}

/**
 * Comodità: pubblica N productIds in sequenza (banale, senza throttling fine).
 */
export async function publishProductsBatch(
  productIds: string[],
  publicationId?: string
): Promise<{ ok: true; published: number }> {
  let published = 0;
  for (const pid of productIds) {
    await publishProductToPublication({ productId: pid, publicationId });
    published++;
  }
  return { ok: true, published };
}

// -------------------- Compat vecchio nome --------------------
export async function shopifyAdminGraphQL(
  a: any,
  b?: any,
  c?: any,
  d?: any
) {
  // Vecchia firma: (shop, token, query, variables)
  if (typeof c === "string") {
    return adminFetchGQL(c, d);
  }
  // Nuova firma: (query, variables)
  return adminFetchGQL(a, b);
}
