let _syncedFunctionId = "";

/**
 * @param {any} admin - Shopify admin GraphQL client from authenticate.admin()
 */
export async function syncValidation(admin) {
  let validationFn;
  try {
    const res = await admin.graphql(
      `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
    );
    const data = await res.json();
    const functions = data.data?.shopifyFunctions?.nodes ?? [];
    validationFn = functions.find(
      (f) =>
        f.apiType === "cart_checkout_validation" ||
        f.title === "B2B Checkout Validation" ||
        f.title === "cart-checkout-validation"
    );
    if (!validationFn) {
      console.warn("[B2B] syncValidation: function not found in shopifyFunctions");
      return;
    }
    console.log(`[B2B] syncValidation: found function ${validationFn.id} (${validationFn.apiType})`);
  } catch (err) {
    console.error("[B2B] syncValidation: failed to query functions:", err);
    return;
  }

  if (validationFn.id === _syncedFunctionId) return;

  try {
    const existingRes = await admin.graphql(`
      query {
        validations(first: 25) {
          nodes {
            id
            enabled
            blockOnFailure
            shopifyFunction { id }
          }
        }
      }
    `);
    const existingData = await existingRes.json();
    const validations = existingData.data?.validations?.nodes ?? [];
    const existing = validations.find((v) => v.shopifyFunction?.id === validationFn.id);

    console.log(`[B2B] syncValidation: existing rule = ${JSON.stringify(existing ?? null)}`);

    if (existing?.enabled) {
      console.log(`[B2B] syncValidation: already enabled → ${existing.id}`);
      _syncedFunctionId = validationFn.id;
      return;
    }

    if (existing) {
      const updateRes = await admin.graphql(
        `mutation UpdateValidation($id: ID!) {
          validationUpdate(id: $id, validation: { enable: true, blockOnFailure: true }) {
            validation { id enabled blockOnFailure }
            userErrors { field message }
          }
        }`,
        { variables: { id: existing.id } }
      );
      const updateData = await updateRes.json();
      console.log("[B2B] syncValidation: update response:", JSON.stringify(updateData.data?.validationUpdate));
      const errs = updateData.data?.validationUpdate?.userErrors ?? [];
      if (errs.length) {
        console.error("[B2B] syncValidation: update error:", errs.map((e) => e.message).join("; "));
        return;
      }
      _syncedFunctionId = validationFn.id;
      return;
    }

    const createRes = await admin.graphql(
      `mutation CreateValidation($functionId: String!) {
        validationCreate(validation: {
          functionId: $functionId
          blockOnFailure: true
        }) {
          validation { id enabled blockOnFailure }
          userErrors { field message }
        }
      }`,
      { variables: { functionId: validationFn.id } }
    );
    const createData = await createRes.json();
    console.log("[B2B] syncValidation: create response:", JSON.stringify(createData.data?.validationCreate));
    const createErrs = createData.data?.validationCreate?.userErrors ?? [];
    if (createErrs.length) {
      console.error("[B2B] syncValidation: create error:", createErrs.map((e) => e.message).join("; "));
      return;
    }
    const newValidation = createData.data?.validationCreate?.validation;
    if (newValidation && !newValidation.enabled) {
      console.warn("[B2B] syncValidation: created but enabled=false — enabling now");
      const enableRes = await admin.graphql(
        `mutation EnableValidation($id: ID!) {
          validationUpdate(id: $id, validation: { enable: true }) {
            validation { id enabled }
            userErrors { field message }
          }
        }`,
        { variables: { id: newValidation.id } }
      );
      const enableData = await enableRes.json();
      console.log("[B2B] syncValidation: enable response:", JSON.stringify(enableData.data?.validationUpdate));
    }
    _syncedFunctionId = validationFn.id;
  } catch (err) {
    console.error("[B2B] syncValidation failed:", err);
  }
}
