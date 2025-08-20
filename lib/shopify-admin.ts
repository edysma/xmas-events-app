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

if (!SHOP_DOMAIN) {
  throw new Error(
    "Missing env: SHOPIFY_STORE_DOMAIN (o SHOP_DOMAIN in fallback)"
  );
}

const GQL_URL = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

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

export async function getDefaultLocationId(): Promise<string> {
  if (process.env.DEFAULT_LOCATION_ID) return process.env.DEFAULT_LOCATION_ID;

  const q = /* GraphQL */ `
    query GetOneLocation {
      locations(first: 1) {
        edges {
          node {
            id
            name
          }
        }
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
// compat: supporta sia la firma nuova (query, variables)
// sia la vecchia (shop, token, query, variables)
export async function shopifyAdminGraphQL(
  a: any,
  b?: any,
  c?: any,
  d?: any
) {
  // vecchia firma: (shop, token, query, variables)
  if (typeof c === "string") {
    return adminFetchGQL(c, d);
  }
  // nuova firma: (query, variables)
  return adminFetchGQL(a, b);
}

