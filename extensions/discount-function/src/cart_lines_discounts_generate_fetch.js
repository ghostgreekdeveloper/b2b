// @ts-check

/**
 * @typedef {import("../generated/api").CartFetchInput} CartFetchInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateFetchResult} CartLinesDiscountsGenerateFetchResult
 */

/**
 * @param {CartFetchInput} input
 * @returns {CartLinesDiscountsGenerateFetchResult}
 */
export function cartLinesDiscountsGenerateFetch(input) {
  // App URL is set as a cart attribute by the theme JS on every storefront page load.
  // This avoids the shop metafield approach which is silently null in function context.
  const appUrl = (
    input.cart.appUrl?.value ||
    input.shop?.appUrlV1?.value ||
    input.shop?.appUrlV2?.value ||
    ""
  ).replace(/\/$/, "");
  if (!appUrl) return {};

  const customerId = input.cart.buyerIdentity?.customer?.id ?? "";

  const cartItems = input.cart.lines
    .filter((line) => line.merchandise.__typename === "ProductVariant")
    .map((line) => ({
      variantId: line.merchandise.id,
      productId: line.merchandise.product?.id ?? null,
      quantity: line.quantity,
    }));

  if (!cartItems.length) return {};

  return {
    request: {
      url: `${appUrl}/discount-function`,
      method: "POST",
      headers: [{ name: "Content-Type", value: "application/json" }],
      jsonBody: { customerId, cartItems },
      policy: { readTimeoutMs: 5000 },
    },
  };
}
