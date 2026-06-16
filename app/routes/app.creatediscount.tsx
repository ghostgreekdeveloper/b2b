import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, Form } from "@remix-run/react";
import { Page, LegacyCard, Button, Text, Banner, BlockStack, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { syncDiscount } from "../syncDiscount.server";
import db from "../db.server";
import { getDiscountMapForCustomer } from "../customerserver.server";

const DISCOUNT_TITLE = "B2B Wholesale Pricing";

async function getShopId(admin: any): Promise<string | null> {
  const res = await admin.graphql(`query { shop { id } }`);
  const data = await res.json();
  return data.data?.shop?.id ?? null;
}

async function syncAppUrl(admin: any): Promise<{ ok: boolean; url: string; error?: string }> {
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  if (!appUrl) return { ok: false, url: "", error: "SHOPIFY_APP_URL env var is not set" };

  const shopId = await getShopId(admin);
  if (!shopId) return { ok: false, url: appUrl, error: "Could not read shop ID" };

  const res = await admin.graphql(
    `mutation SyncAppUrl($fields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $fields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        fields: [
          // $app:b2b — read by Shopify Function WASM at checkout
          {
            ownerId: shopId,
            namespace: "$app:b2b",
            key: "app_url",
            value: appUrl,
            type: "single_line_text_field",
          },
          // b2b_wholesale — read by Liquid theme extension (storefront)
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
  const data = await res.json();
  const errors: any[] = data.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) return { ok: false, url: appUrl, error: errors.map((e: any) => e.message).join("; ") };
  return { ok: true, url: appUrl };
}

async function readAppUrlMetafield(admin: any): Promise<string | null> {
  const res = await admin.graphql(
    `query GetAppUrl {
      shop { metafield(namespace: "b2b_wholesale", key: "app_url") { value } }
    }`
  );
  const data = await res.json();
  return data.data?.shop?.metafield?.value ?? null;
}

async function queryAllFunctions(admin: any): Promise<{ id: string; title: string; apiType: string }[]> {
  const res = await admin.graphql(
    `query { shopifyFunctions(first: 50) { nodes { id title apiType } } }`
  );
  const data = await res.json();
  return data.data?.shopifyFunctions?.nodes ?? [];
}

function pickDiscountFunction(functions: { id: string; title: string; apiType: string }[]) {
  return (
    functions.find((f) => f.apiType === "discounts") ??
    functions.find((f) =>
      f.title === "function-discount-wholesale" ||
      f.title === "B2B Wholesale Pricing" ||
      f.title.toLowerCase().includes("wholesale") ||
      f.title === "discount-function"
    ) ??
    null
  );
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: any) => {
  const { admin } = await authenticate.admin(request);

  // Run in background — won't block the page render but fixes drift immediately
  syncDiscount(admin).catch(() => {});

  const [discountRes, syncResult, storedUrl, allFunctions] = await Promise.all([
    admin.graphql(`
      query {
        discountNodes(first: 10, query: "title:'B2B Wholesale Pricing'") {
          nodes {
            id
            discount {
              ... on DiscountAutomaticApp {
                title
                status
                startsAt
                appDiscountType { functionId }
              }
            }
          }
        }
      }
    `).then((r: any) => r.json()),
    syncAppUrl(admin),
    readAppUrlMetafield(admin),
    queryAllFunctions(admin),
  ]);

  const currentFn = pickDiscountFunction(allFunctions);
  const nodes: any[] = discountRes.data?.discountNodes?.nodes ?? [];
  const existing = nodes.find((n) => n.discount?.title === DISCOUNT_TITLE) ?? null;

  const storedFunctionId: string | null = existing?.discount?.appDiscountType?.functionId ?? null;
  const currentFunctionId: string | null = currentFn?.id ?? null;
  const functionMismatch = !!(storedFunctionId && currentFunctionId && storedFunctionId !== currentFunctionId);

  // DB diagnostic — shows what the server would do for each customer at checkout
  const acceptedCustomers = await db.customers.findMany({
    where: { applicationStatus: "ACCEPTED" },
    include: { catalog: { include: { items: true } } },
  });

  const diagCustomers = acceptedCustomers.map((c: any) => {
    if (!c.catalog) return { id: c.id, email: c.email, issue: "No catalog assigned" };
    const items = c.catalog.items as any[];
    const pricedItems = items.filter((i) => (i.customDiscountPercent ?? 0) > 0);
    const defaultPct = c.catalog.defaultDiscountPercent ?? 0;
    const fallbackItems = defaultPct > 0 ? items.filter((i) => (i.customPriceCents ?? 0) > 0) : [];
    return {
      id: c.id,
      email: c.email,
      catalogTitle: c.catalog.title,
      totalItems: items.length,
      pricedItems: pricedItems.length,
      defaultDiscountPercent: defaultPct,
      fallbackItems: fallbackItems.length,
      discountableItems: pricedItems.length + (pricedItems.length === 0 ? fallbackItems.length : 0),
      issue: pricedItems.length === 0 && fallbackItems.length === 0
        ? "No discounted prices set — set a global % discount or per-item price in the catalog"
        : null,
    };
  });

  return json({
    existing, syncResult, storedUrl, currentFn, functionMismatch,
    storedFunctionId, currentFunctionId,
    allFunctions, diagCustomers,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: any) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("_action");

  const syncResult = await syncAppUrl(admin);

  // ── Live discount lookup test ──
  if (intent === "diag") {
    const customerId = formData.get("customerId")?.toString() ?? "";
    if (!customerId) return json({ intent: "diag", syncResult, diagResult: { error: "No customer ID entered" } });
    try {
      const map = await getDiscountMapForCustomer(customerId);
      const keys = Object.keys(map);
      return json({
        intent: "diag",
        syncResult,
        diagResult: {
          customerId,
          discountCount: keys.length,
          sample: keys.slice(0, 5).map((k) => ({ variantId: k, ...map[k] })),
        },
      });
    } catch (err: any) {
      return json({ intent: "diag", syncResult, diagResult: { error: String(err?.message ?? err) } });
    }
  }

  // ── Test endpoint ──
  if (intent === "test") {
    const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
    if (!appUrl) {
      return json({ intent: "test", syncResult, testResult: { ok: false, error: "SHOPIFY_APP_URL not set" } });
    }
    const endpoint = `${appUrl}/discount-function`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: "", cartItems: [] }),
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
      return json({ intent: "test", syncResult, testResult: { ok: res.ok, status: res.status, endpoint, body: parsed ?? text.slice(0, 200) } });
    } catch (err: any) {
      return json({ intent: "test", syncResult, testResult: { ok: false, endpoint, error: String(err?.message ?? err) } });
    }
  }

  // ── Delete existing discount (used before recreating) ──
  if (intent === "delete") {
    const discountRes = await admin.graphql(`
      query {
        discountNodes(first: 10, query: "title:'B2B Wholesale Pricing'") {
          nodes { id discount { ... on DiscountAutomaticApp { title } } }
        }
      }
    `);
    const discountData = await discountRes.json();
    const nodes: any[] = discountData.data?.discountNodes?.nodes ?? [];
    const toDelete = nodes.filter((n) => n.discount?.title === DISCOUNT_TITLE);

    const errors: string[] = [];
    for (const node of toDelete) {
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
      if (errs.length) errors.push(errs.map((e: any) => e.message).join("; "));
    }

    if (errors.length) return json({ intent: "delete", syncResult, error: errors.join(" | ") });
    return json({ intent: "delete", syncResult, deleted: toDelete.length });
  }

  // ── Create discount ──
  const allFns = await queryAllFunctions(admin);
  const currentFn = pickDiscountFunction(allFns);

  if (!currentFn) {
    const summary = allFns.map((f) => `"${f.title}" (${f.apiType})`).join(", ") || "(none)";
    return json({ intent: "create", syncResult, error: `No discount function found. Available functions: ${summary}` });
  }

  const createRes = await admin.graphql(
    `mutation CreateWholesaleDiscount($input: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $input) {
        automaticAppDiscount { discountId title status startsAt }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          title: DISCOUNT_TITLE,
          functionId: currentFn.id,
          startsAt: new Date().toISOString(),
          discountClasses: ["PRODUCT"],
          combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        },
      },
    }
  );

  const createData = await createRes.json();
  const result = createData.data?.discountAutomaticAppCreate;

  if (result?.userErrors?.length) {
    return json({ intent: "create", syncResult, error: result.userErrors.map((e: any) => e.message).join("; ") });
  }

  return json({ intent: "create", syncResult, success: true, discount: result?.automaticAppDiscount, functionId: currentFn.id });
};

// ── UI ────────────────────────────────────────────────────────────────────────
export default function SetupDiscountPage() {
  const { existing, syncResult, storedUrl, currentFn, functionMismatch, storedFunctionId, currentFunctionId, allFunctions, diagCustomers } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state !== "idle";
  const currentIntent = nav.formData?.get("_action");

  const ad = actionData as any;
  const currentSyncResult = ad?.syncResult ?? syncResult;

  // After delete succeeds, existing is gone — treat it as if we need to create
  const showCreateButton = !existing || ad?.intent === "delete" && !ad?.error;

  return (
    <Page title="Wholesale Discount Setup">
      <BlockStack gap="400">

        {/* ── Step 1: App URL ── */}
        <LegacyCard sectioned title="Step 1 — App URL (auto-synced)">
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Written to a shop metafield so the Shopify Function WASM can read it at checkout.
            </Text>
            {currentSyncResult?.ok ? (
              <Banner tone="success">
                <p>Synced: <strong>{currentSyncResult.url}</strong></p>
                {storedUrl && storedUrl !== currentSyncResult.url && (
                  <p>Previously stored: {storedUrl}</p>
                )}
              </Banner>
            ) : (
              <Banner tone="critical">
                <p>Sync failed: {currentSyncResult?.error}</p>
                <p>SHOPIFY_APP_URL = {currentSyncResult?.url || "(not set)"}</p>
              </Banner>
            )}
          </BlockStack>
        </LegacyCard>

        {/* ── Step 2: Test endpoint ── */}
        <LegacyCard sectioned title="Step 2 — Test /discount-function endpoint">
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Sends a test POST from the server. If this returns 200, the WASM can reach your server at checkout.
            </Text>
            {ad?.intent === "test" && ad?.testResult && (
              ad.testResult.ok ? (
                <Banner tone="success">
                  <p>Reachable — status {ad.testResult.status}</p>
                  <p><strong>{ad.testResult.endpoint}</strong></p>
                  <p>Body: {JSON.stringify(ad.testResult.body)}</p>
                </Banner>
              ) : (
                <Banner tone="critical">
                  <p>Not reachable: {ad.testResult.endpoint ?? "(URL not set)"}</p>
                  <p>{ad.testResult.error ?? `HTTP ${ad.testResult.status}`}</p>
                </Banner>
              )
            )}
            <Form method="post">
              <input type="hidden" name="_action" value="test" />
              <Button submit loading={submitting && currentIntent === "test"} variant="secondary">
                Test Endpoint Now
              </Button>
            </Form>
          </BlockStack>
        </LegacyCard>

        {/* ── Step 3: Automatic Discount ── */}
        <LegacyCard sectioned title="Step 3 — Automatic Discount">
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Links the discount function to every checkout. Must use the <em>current session's</em> function ID —
              restart <code>shopify app dev</code> then delete and recreate if it was made in a prior session.
            </Text>

            {/* Function ID mismatch warning — most common cause of silent failures */}
            {functionMismatch && (
              <Banner tone="warning">
                <p><strong>Function ID mismatch — this is why discounts aren't applying.</strong></p>
                <p>Discount uses: <code>{storedFunctionId}</code></p>
                <p>Current session: <code>{currentFunctionId}</code></p>
                <p>Delete the discount below and recreate it to fix this.</p>
              </Banner>
            )}

            {!currentFn && (
              <Banner tone="critical">
                <p><strong>No discount function found.</strong></p>
                {allFunctions.length === 0 ? (
                  <p>No functions returned at all — is <code>shopify app dev</code> running and fully started?</p>
                ) : (
                  <p>
                    Functions available but none matched:{" "}
                    {allFunctions.map((f: any) => `"${f.title}" (${f.apiType})`).join(", ")}
                  </p>
                )}
              </Banner>
            )}

            {currentFn && (
              <Banner tone="info">
                <p>Current function: <strong>{currentFn.title}</strong></p>
                <p>ID: <code>{currentFn.id}</code></p>
              </Banner>
            )}

            {existing && !(ad?.intent === "delete" && !ad?.error) ? (
              <Banner tone={functionMismatch ? "warning" : "success"}>
                <p><strong>{functionMismatch ? "Stale discount active" : "Active."}</strong> {existing.discount?.title}</p>
                <p>Status: {existing.discount?.status} | Function ID: <code>{storedFunctionId}</code></p>
              </Banner>
            ) : null}

            {ad?.intent === "delete" && !ad?.error && (
              <Banner tone="success">
                <p>Deleted {ad.deleted} discount(s). Now create a new one below.</p>
              </Banner>
            )}

            {ad?.intent === "create" && ad?.success && (
              <Banner tone="success">
                <p><strong>Created!</strong> Function ID: <code>{ad.functionId}</code></p>
              </Banner>
            )}

            {ad?.error && <Banner tone="critical"><p>{ad.error}</p></Banner>}

            <InlineStack gap="300">
              {/* Show delete button when there's an existing discount */}
              {existing && !(ad?.intent === "delete" && !ad?.error) && (
                <Form method="post">
                  <input type="hidden" name="_action" value="delete" />
                  <Button
                    submit
                    loading={submitting && currentIntent === "delete"}
                    tone="critical"
                    variant="secondary"
                  >
                    Delete Discount
                  </Button>
                </Form>
              )}

              {/* Show create button when no existing discount */}
              {showCreateButton && currentFn && (
                <Form method="post">
                  <input type="hidden" name="_action" value="create" />
                  <Button
                    submit
                    loading={submitting && currentIntent === "create"}
                    variant="primary"
                  >
                    Create Wholesale Discount
                  </Button>
                </Form>
              )}
            </InlineStack>
          </BlockStack>
        </LegacyCard>

        {/* ── Diagnostic: DB state ── */}
        <LegacyCard sectioned title="Diagnostic — Customer & Catalog Setup">
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Shows every ACCEPTED customer and whether their catalog has prices configured.
              If "Discountable items" is 0, no discount will ever be applied for that customer.
            </Text>

            {(diagCustomers as any[]).length === 0 && (
              <Banner tone="warning">
                <p>No ACCEPTED customers found in the database. Approve a customer application first.</p>
              </Banner>
            )}

            {(diagCustomers as any[]).map((c: any) => (
              <Banner key={c.id} tone={c.issue ? "critical" : "success"}>
                <p>
                  <strong>{c.email ?? c.id}</strong>
                  {c.catalogTitle ? ` → catalog: "${c.catalogTitle}"` : " → NO CATALOG"}
                </p>
                {c.catalogTitle && (
                  <p>
                    Items: {c.totalItems} total, {c.pricedItems} with explicit price,
                    {" "}{c.fallbackItems} via global {c.defaultDiscountPercent}% — {" "}
                    <strong>{c.discountableItems} discountable</strong>
                  </p>
                )}
                {c.issue && <p>⚠ {c.issue}</p>}
              </Banner>
            ))}

            {/* Live lookup test with a specific customer ID */}
            <Form method="post">
              <input type="hidden" name="_action" value="diag" />
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flexGrow: 1 }}>
                  <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
                    Test discount lookup with customer ID (numeric, e.g. 6789012345):
                  </label>
                  <input
                    name="customerId"
                    type="text"
                    placeholder="6789012345"
                    style={{ width: "100%", padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
                  />
                </div>
                <Button submit loading={submitting && currentIntent === "diag"} variant="secondary">
                  Test Lookup
                </Button>
              </InlineStack>
            </Form>

            {ad?.intent === "diag" && ad?.diagResult && (
              ad.diagResult.error ? (
                <Banner tone="critical"><p>{ad.diagResult.error}</p></Banner>
              ) : (
                <Banner tone={ad.diagResult.discountCount > 0 ? "success" : "warning"}>
                  <p>Customer <code>{ad.diagResult.customerId}</code> → <strong>{ad.diagResult.discountCount} variant discounts</strong></p>
                  {ad.diagResult.discountCount === 0 && (
                    <p>No discounts found — customer not ACCEPTED, no catalog, or catalog has no prices set.</p>
                  )}
                  {(ad.diagResult.sample ?? []).map((s: any, i: number) => (
                    <p key={i}><code>{s.variantId}</code>: wholesale {s.wholesalePriceCents}¢ / retail {s.originalPriceCents}¢ ({s.discountPercent}% off)</p>
                  ))}
                </Banner>
              )
            )}
          </BlockStack>
        </LegacyCard>

      </BlockStack>
    </Page>
  );
}
