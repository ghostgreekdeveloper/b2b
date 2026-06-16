// Ensures the automatic discount always points to the correct function ID
// and uses the discount title configured in the catalog (discountTitle field).
// When either the function ID or the title drifts, the old discount is deleted
// and a fresh one is created automatically.

import db from "./db.server";

const DEFAULT_TITLE = "Wholesale Pricing";

let _syncedFunctionId = "";
let _syncedTitle = "";

/**
 * Reads the discount title from the DB: uses the most recently updated
 * catalog that has a discountTitle set, otherwise falls back to DEFAULT_TITLE.
 */
async function getDiscountTitle() {
  try {
    const catalog = await db.catalog.findFirst({
      where: { discountTitle: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { discountTitle: true },
    });
    return catalog?.discountTitle?.trim() || DEFAULT_TITLE;
  } catch {
    return DEFAULT_TITLE;
  }
}

/**
 * @param {any} admin - Shopify admin GraphQL client from authenticate.admin()
 */
export async function syncDiscount(admin) {
  // 1. Find the currently deployed function
  let currentFn;
  try {
    const fnRes = await admin.graphql(
      `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
    );
    const fnData = await fnRes.json();
    const functions = fnData.data?.shopifyFunctions?.nodes ?? [];

    console.log(
      "[B2B] syncDiscount: available functions →",
      functions.map((f) => `"${f.title}" (${f.apiType})`).join(", ") || "(none)"
    );

    currentFn =
      functions.find((f) => f.apiType === "discounts") ??
      functions.find(
        (f) =>
          f.title === "function-discount-wholesale" ||
          f.title.toLowerCase().includes("wholesale") ||
          f.title === "discount-function"
      );
  } catch (err) {
    console.error("[B2B] syncDiscount: failed to query functions:", err);
    return;
  }

  if (!currentFn) {
    console.warn("[B2B] syncDiscount: no discount function found");
    return;
  }

  // 2. Read the desired title from DB
  const desiredTitle = await getDiscountTitle();

  // 3. Nothing changed since last sync
  if (currentFn.id === _syncedFunctionId && desiredTitle === _syncedTitle) return;

  try {
    // 4. Find ALL existing discounts created by our function (search by function ID)
    const discountRes = await admin.graphql(`
      query {
        discountNodes(first: 25) {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                appDiscountType { functionId }
              }
            }
          }
        }
      }
    `);
    const discountData = await discountRes.json();
    const nodes = discountData.data?.discountNodes?.nodes ?? [];

    // Our discounts: matching current or previous function ID, or previous title
    const ours = nodes.filter((n) => {
      const fnId = n.discount?.appDiscountType?.functionId;
      const t = n.discount?.title;
      return fnId === currentFn.id || fnId === _syncedFunctionId || t === _syncedTitle;
    });

    const existing = ours[0];
    const existingFunctionId = existing?.discount?.appDiscountType?.functionId;
    const existingTitle = existing?.discount?.title;

    if (
      existing &&
      existingFunctionId === currentFn.id &&
      existingTitle === desiredTitle
    ) {
      console.log(
        `[B2B] syncDiscount: already up to date → "${desiredTitle}" / ${currentFn.id}`
      );
      _syncedFunctionId = currentFn.id;
      _syncedTitle = desiredTitle;
      return;
    }

    // 5. Delete stale discounts
    for (const node of ours) {
      const delRes = await admin.graphql(
        `mutation DeleteDiscount($id: ID!) {
          discountAutomaticDelete(id: $id) {
            userErrors { field message }
          }
        }`,
        { variables: { id: node.id } }
      );
      const delData = await delRes.json();
      const errs = delData.data?.discountAutomaticDelete?.userErrors ?? [];
      if (errs.length) {
        console.error("[B2B] syncDiscount: delete error:", errs);
        return;
      }
      console.log(
        `[B2B] syncDiscount: deleted stale discount ${node.id} ("${node.discount?.title}")`
      );
    }

    // 6. Create fresh discount with current function ID and desired title
    const createRes = await admin.graphql(
      `mutation CreateWholesaleDiscount($input: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $input) {
          automaticAppDiscount { discountId title status }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            title: desiredTitle,
            functionId: currentFn.id,
            startsAt: new Date().toISOString(),
            discountClasses: ["PRODUCT"],
            combinesWith: {
              orderDiscounts: false,
              productDiscounts: false,
              shippingDiscounts: false,
            },
          },
        },
      }
    );

    const createData = await createRes.json();
    const result = createData.data?.discountAutomaticAppCreate;
    const createErrs = result?.userErrors ?? [];

    if (createErrs.length) {
      console.error(
        "[B2B] syncDiscount: create error:",
        createErrs.map((e) => e.message).join("; ")
      );
      return;
    }

    console.log(
      `[B2B] syncDiscount: created discount "${desiredTitle}" → ${result?.automaticAppDiscount?.discountId}`
    );
    _syncedFunctionId = currentFn.id;
    _syncedTitle = desiredTitle;
  } catch (err) {
    console.error("[B2B] syncDiscount failed:", err);
  }
}
