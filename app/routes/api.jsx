import { json } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");

  const session = await db.session.findFirst({
    where: shopParam
      ? { shop: shopParam, isOnline: false }
      : { isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session) {
    return json({ error: "No session found" }, { status: 401 });
  }

  async function adminGraphQL(query, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(
          `https://${session.shop}/admin/api/2025-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": session.accessToken,
            },
            body: JSON.stringify({ query }),
          }
        );
        const data = await response.json();
        if (data.errors) {
          const isRateLimit = data.errors.some(
            (e) => e.message?.includes("Throttled") || e.message?.includes("Rate limit")
          );
          if (isRateLimit && attempt < retries) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            continue;
          }
          return data;
        }
        return data;
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  const BATCH_SIZE = 250;
  let allProducts = [];
  let hasNextPage = true;
  let endCursor = null;

  while (hasNextPage) {
    const query = `
      {
        products(first: ${BATCH_SIZE}${endCursor ? `, after: "${endCursor}"` : ""}) {
          edges {
            node {
              id
              title
              description
              featuredImage { url altText }
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    compareAtPrice
                    availableForSale
                    inventoryQuantity
                    image { url altText }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const data = await adminGraphQL(query);

    if (data.errors) {
      return json({ error: "Failed to fetch products", details: data.errors }, { status: 500 });
    }

    const products = (data?.data?.products?.edges || []).flatMap((p) =>
      p.node.variants.edges.map((v) => ({
        id: v.node.id,
        productId: p.node.id,
        name: `${p.node.title} - ${v.node.title}`,
        productTitle: p.node.title,
        variantTitle: v.node.title,
        sku: v.node.sku,
        description: p.node.description,
        price: { amount: v.node.price, currencyCode: "EUR" },
        compareAtPrice: v.node.compareAtPrice
          ? { amount: v.node.compareAtPrice, currencyCode: "EUR" }
          : null,
        availableForSale: v.node.availableForSale,
        quantityAvailable: v.node.inventoryQuantity,
        currentlyNotInStock: !v.node.availableForSale,
        featuredImage: p.node.featuredImage,
        variantImage: v.node.image,
        availability: [{ location: "Total", available: v.node.inventoryQuantity ?? 0 }],
        selected: false,
      }))
    );

    allProducts.push(...products);
    hasNextPage = data.data.products.pageInfo.hasNextPage;
    endCursor = data.data.products.pageInfo.endCursor;

    console.log(`Fetched batch: ${products.length} variants, hasNextPage: ${hasNextPage}`);
  }

  return json({ products: allProducts });
};
