// Writes process.env.SHOPIFY_APP_URL to a shop metafield so the Shopify Function
// (which runs as WASM and cannot access env vars) can read the current app URL
// at checkout time.
//
// Uses a module-level flag so the write happens only once per server process,
// not on every request. When the tunnel URL changes (new shopify app dev session),
// the server restarts and the flag resets, triggering a fresh write.

let _syncedUrl = "";

/**
 * @param {any} admin - Shopify admin GraphQL client from authenticate.admin()
 */
export async function syncAppUrlToShop(admin) {
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  if (!appUrl || appUrl === _syncedUrl) return;

  try {
    const shopRes = await admin.graphql(`query { shop { id } }`);
    const shopData = await shopRes.json();
    const shopId = shopData.data?.shop?.id;
    if (!shopId) return;

    const setRes = await admin.graphql(
      `mutation SetAppUrl($fields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $fields) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          fields: [
            // $app:b2b — read by the Shopify Function WASM at checkout
            {
              ownerId: shopId,
              namespace: "$app:b2b",
              key: "app_url",
              value: appUrl,
              type: "single_line_text_field",
            },
            // b2b_wholesale — read by the Liquid theme extension (storefront display)
            {
              ownerId: shopId,
              namespace: "b2b_wholesale",
              key: "app_url",
              value: appUrl,
              type: "single_line_text_field",
            },
          ],
        },
      }
    );

    const setData = await setRes.json();
    const errors = setData.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length) {
      console.error("[B2B] app_url metafield error:", errors);
    } else {
      console.log("[B2B] app_url synced →", appUrl);
      _syncedUrl = appUrl;
    }
  } catch (err) {
    console.error("[B2B] syncAppUrlToShop failed:", err);
  }
}
