// app/api/availability/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

// CORS aperto (come events-feed)
function withCORS(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.append("Vary", "Origin");
  return res;
}
export function OPTIONS() {
  return withCORS(new NextResponse(null, { status: 204 }));
}

// Accetta numeric ID o GID
function toGid(kind: "ProductVariant" | "Location", id: string) {
  return id.startsWith("gid://") ? id : `gid://shopify/${kind}/${id}`;
}

const DEFAULT_LOCATION_ID = process.env.DEFAULT_LOCATION_ID || "";

// --- GQL: risolvi Seat Unit da una bundle variant (metafield sinflora.seat_unit)
const QUERY_SEAT_UNIT_FROM_BUNDLE = /* GraphQL */ `
  query SeatUnitFromBundle($id: ID!) {
    productVariant(id: $id) {
      id
      metafield(namespace: "sinflora", key: "seat_unit") {
        reference { ... on ProductVariant { id } }
      }
    }
  }
`;

// --- GQL: availability su location specifica
const QUERY_AVAIL_AT_LOCATION = /* GraphQL */ `
  query AvailAtLocation($variantId: ID!, $locationId: ID!) {
    productVariant(id: $variantId) {
      id
      inventoryItem {
        tracked
        inventoryLevel(locationId: $locationId) {
          location { id name }
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  }
`;

// --- GQL: availability su tutte le location (somma)
const QUERY_AVAIL_ALL_LOCATIONS = /* GraphQL */ `
  query AvailAll($variantId: ID!) {
    productVariant(id: $variantId) {
      id
      inventoryItem {
        tracked
        inventoryLevels(first: 50) {
          edges {
            node {
              location { id name }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

type PerLocation = { locationId: string; locationName: string; available: number };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const seatUnitVariantIdRaw = searchParams.get("seatUnitVariantId");
    const bundleVariantIdRaw = searchParams.get("bundleVariantId");
    const locationIdRaw = searchParams.get("locationId") || DEFAULT_LOCATION_ID;

    if (!seatUnitVariantIdRaw && !bundleVariantIdRaw) {
      return withCORS(
        NextResponse.json(
          { ok: false, error: "Passa ?seatUnitVariantId=... oppure ?bundleVariantId=..." },
          { status: 400 }
        )
      );
    }

    // 1) Risolvi la Seat Unit
    let seatUnitGid: string;
    if (seatUnitVariantIdRaw) {
      seatUnitGid = toGid("ProductVariant", seatUnitVariantIdRaw);
    } else {
      const bundleGid = toGid("ProductVariant", bundleVariantIdRaw!);
      const d = await adminFetchGQL<{
        productVariant: { metafield: { reference?: { id: string } } | null } | null;
      }>(QUERY_SEAT_UNIT_FROM_BUNDLE, { id: bundleGid });

      const ref = d?.productVariant?.metafield?.reference as { id: string } | undefined;
      if (!ref?.id) {
        return withCORS(
          NextResponse.json(
            { ok: false, error: "Metafield sinflora.seat_unit mancante su questa bundle variant." },
            { status: 422 }
          )
        );
      }
      seatUnitGid = ref.id;
    }

    // 2) Leggi availability
    let perLocation: PerLocation[] = [];
    let total = 0;
    let tracked = true;

    if (locationIdRaw) {
      const locationGid = toGid("Location", locationIdRaw);
      const data = await adminFetchGQL<{
        productVariant: {
          inventoryItem: {
            tracked: boolean;
            inventoryLevel: {
              location: { id: string; name: string };
              quantities: { name: string; quantity: number }[];
            } | null;
          } | null;
        } | null;
      }>(QUERY_AVAIL_AT_LOCATION, { variantId: seatUnitGid, locationId: locationGid });

      const lvl = data?.productVariant?.inventoryItem?.inventoryLevel;
      tracked = data?.productVariant?.inventoryItem?.tracked ?? true;
      const qty = lvl?.quantities?.find(q => q.name === "available")?.quantity ?? 0;
      perLocation = lvl ? [{ locationId: lvl.location.id, locationName: lvl.location.name, available: qty }] : [];
      total = qty;

      return withCORS(
        NextResponse.json({
          ok: true,
          seatUnitVariantId: seatUnitGid,
          tracked,
          totalAvailable: total,
          perLocation,
          source: "single_location",
        })
      );
    } else {
      const data = await adminFetchGQL<{
        productVariant: {
          inventoryItem: {
            tracked: boolean;
            inventoryLevels: {
              edges: { node: { location: { id: string; name: string }; quantities: { name: string; quantity: number }[] } }[];
            };
          } | null;
        } | null;
      }>(QUERY_AVAIL_ALL_LOCATIONS, { variantId: seatUnitGid });

      const edges = data?.productVariant?.inventoryItem?.inventoryLevels?.edges || [];
      tracked = data?.productVariant?.inventoryItem?.tracked ?? true;

      perLocation = edges.map(e => ({
        locationId: e.node.location.id,
        locationName: e.node.location.name,
        available: e.node.quantities.find(q => q.name === "available")?.quantity ?? 0,
      }));
      total = perLocation.reduce((s, r) => s + r.available, 0);

      return withCORS(
        NextResponse.json({
          ok: true,
          seatUnitVariantId: seatUnitGid,
          tracked,
          totalAvailable: total,
          perLocation,
          source: "sum_all_locations",
        })
      );
    }
  } catch (err: any) {
    return withCORS(NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 }));
  }
}
