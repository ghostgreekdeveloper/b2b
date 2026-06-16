import db from "./db.server";

/**
 * Validates the request origin against shops that have installed the app.
 * Also accepts a `shop` query param (xxx.myshopify.com) so custom-domain
 * storefronts can be matched back to their installed session.
 */
export async function getCorsHeaders(request: Request): Promise<Record<string, string>> {
  const origin = request.headers.get("origin") ?? "";
  if (!origin) return {};

  // Always allow myshopify.com storefronts
  const originDomain = origin.replace(/^https?:\/\//, "").split("/")[0];
  if (originDomain.endsWith(".myshopify.com")) {
    return buildCorsHeaders(origin);
  }

  // For custom domains, try matching via the `shop` query param
  // (injected by the Liquid block as shop.permanent_domain = xxx.myshopify.com)
  try {
    const url = new URL(request.url);
    const shopParam = url.searchParams.get("shop") ?? "";
    if (shopParam && /^[a-z0-9-]+\.myshopify\.com$/i.test(shopParam)) {
      const session = await db.session.findFirst({
        where: { shop: shopParam, isOnline: false },
        select: { shop: true },
      });
      if (session) return buildCorsHeaders(origin);
    }
  } catch {
    // ignore URL parse errors
  }

  // Fall back to checking by origin domain directly (for stores without custom domains
  // that might have a different origin format)
  const session = await db.session.findFirst({
    where: { shop: originDomain, isOnline: false },
    select: { shop: true },
  });
  if (session) return buildCorsHeaders(origin);

  return {};
}

function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export function optionsResponse(corsHeaders: Record<string, string>) {
  return new Response(null, { status: 204, headers: corsHeaders });
}
