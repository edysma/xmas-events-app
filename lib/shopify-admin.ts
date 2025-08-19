// lib/shopify-admin.ts
export const API_VERSION = '2024-07';

export async function shopifyAdminGraphQL(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, any> = {}
): Promise<any> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
      'Accept': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) throw new Error(`GraphQL ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
