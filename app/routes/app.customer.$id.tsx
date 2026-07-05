import { useState } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import {
  Page, Card, BlockStack, InlineStack, InlineGrid, Divider,
  Text, TextField, Button, Badge, Banner, Box, Tag,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  writeCustomerDiscountMetafield,
  clearCustomerDiscountMetafield,
} from "../writeCustomerMetafield.server";
import { customerStateCache, catalogIdsCache } from "../cache.server";
import { sendEmail, approvedHtml, rejectedHtml, parseEmailBlocks, renderEmailBlocks } from "../email.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { id } = params;
  if (!id) throw new Response("Missing ID", { status: 400 });

  const customer = await db.customers.findUnique({
    where: { id },
    include: { shippingAddress: true, billingAddress: true, catalog: { select: { id: true, title: true } } },
  });
  if (!customer) throw new Response("Customer not found", { status: 404 });

  // Fetch Shopify tags + detect segment/catalog
  let customerTags: string[] = [];
  let autoSegment: { title: string; id: string } | null = null;
  let autoCatalogs: { title: string; id: number }[] = [];

  const allSegments = await db.segment.findMany({
    select: { id: true, title: true, customercondition: true },
    where: { status: "Active" },
  });
  const segmentTags = allSegments.map((s) => s.customercondition).filter(Boolean);

  try {
    const numericId = id.includes("/") ? id.split("/").pop()! : id;
    const res = await admin.graphql(
      `query { customer(id: "gid://shopify/Customer/${numericId}") { tags email } }`
    );
    const data = await res.json();
    customerTags = data?.data?.customer?.tags ?? [];
    const customerEmail: string = (data?.data?.customer?.email ?? "").toLowerCase();

    const matchesTier = async (cond: string | null): Promise<boolean> => {
      const s = cond ?? "";
      if (s.startsWith("domain:")) {
        const domain = s.slice(7).toLowerCase();
        return customerEmail.endsWith(`@${domain}`);
      }
      if (s.startsWith("customers:")) {
        const ids = s.slice(10).split(",").filter(Boolean);
        const numericId = id.includes("/") ? id.split("/").pop()! : id;
        return ids.includes(numericId);
      }
      if (s.startsWith("shopify_segment:")) {
        const segGid = s.slice(17);
        const numericId = id.includes("/") ? id.split("/").pop()! : id;
        const customerGid = `gid://shopify/Customer/${numericId}`;
        try {
          const res = await admin.graphql(
            `query SegmentMembers($segId: ID!) {
              customerSegmentMembers(segmentId: $segId, first: 250) { nodes { id } }
            }`,
            { variables: { segId: segGid } }
          );
          const d = await res.json();
          const members: string[] = (d?.data?.customerSegmentMembers?.nodes ?? []).map((n: any) => n.id);
          return members.includes(customerGid);
        } catch { return false; }
      }
      const tag = s.startsWith("tag:") ? s.slice(4) : s;
      return customerTags.includes(tag);
    };

    {
      let matched = null;
      for (const s of allSegments) {
        if (await matchesTier(s.customercondition)) { matched = s; break; }
      }
      if (matched) {
        autoSegment = { title: matched.title, id: matched.id };
        const cats = await db.catalog.findMany({
          where: { segmentId: matched.id, status: "active" },
          select: { id: true, title: true },
          orderBy: { id: "asc" },
        });
        autoCatalogs = (cats as any[]).map((c) => ({ id: Number(c.id), title: c.title as string }));
      }
    }
  } catch (err) {
    console.error("[B2B] could not fetch customer tags:", err);
  }

  // Load all catalogs currently assigned to this customer
  const numericCid = id.includes("/") ? id.split("/").pop()! : id;
  const junctionRows = await db.$queryRaw<{ catalogId: number }[]>`
    SELECT "catalogId" FROM customer_catalogs WHERE "customerId" = ${numericCid}
  `;
  let assignedIds = junctionRows.map((r) => Number(r.catalogId));
  if (assignedIds.length === 0 && customer.catalog?.id) assignedIds = [customer.catalog.id];
  const assignedCatalogs: { id: number; title: string; status: string }[] =
    assignedIds.length > 0
      ? ((await db.catalog.findMany({
          where: { id: { in: assignedIds } },
          select: { id: true, title: true, status: true },
          orderBy: { id: "asc" },
        })) as any[]).map((c) => ({ id: Number(c.id), title: c.title as string, status: c.status as string }))
      : [];

  // Self-heal: if this ACCEPTED customer has no catalog yet, try to enroll them now
  // based on their current Shopify tags. Covers the case where admin added the tag
  // in Shopify after the customer was already approved, without visiting the catalog page.
  if (customer.applicationStatus === "ACCEPTED" && assignedCatalogs.length === 0 && customerTags.length > 0) {
    try {
      const segments = await db.segment.findMany({
        where: { status: "Active" }, select: { id: true, customercondition: true },
      });
      const matchedSegments = segments.filter((s) => {
        const cond = s.customercondition ?? "";
        if (cond.startsWith("domain:") || cond.startsWith("customers:") || cond.startsWith("shopify_segment:")) return false;
        const tag = cond.startsWith("tag:") ? cond.slice(4) : cond;
        return customerTags.includes(tag);
      });
      const toEnroll: number[] = [];
      for (const seg of matchedSegments) {
        const cats = await db.catalog.findMany({
          where: { segmentId: seg.id, status: "active" }, select: { id: true },
        });
        cats.forEach((c: any) => { const cid = Number(c.id); if (!toEnroll.includes(cid)) toEnroll.push(cid); });
      }
      if (toEnroll.length > 0) {
        const numId = id.includes("/") ? id.split("/").pop()! : id;
        for (const catId of toEnroll) {
          await db.$executeRaw`INSERT INTO customer_catalogs ("customerId", "catalogId") VALUES (${numId}, ${catId}) ON CONFLICT DO NOTHING`;
        }
        await db.customers.updateMany({ where: { id: numId, catalogId: null }, data: { catalogId: toEnroll[0] } });
        writeCustomerDiscountMetafield(admin, numId, customer.shopDomain).catch(() => {});
        console.log(`[B2B] self-healed enrollment for ${numId} into catalogs [${toEnroll}]`);
      }
    } catch (err) {
      console.error("[B2B] self-heal enrollment error:", err);
    }
  }

  return json({ customer, autoSegment, autoCatalogs, assignedCatalogs, customerTags, segmentTags });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const { id } = params;
  if (!id) throw new Response("Missing ID", { status: 400 });

  const formData = await request.formData();
  const intent = formData.get("intent")?.toString();

  if (intent === "refresh-metafield") {
    await writeCustomerDiscountMetafield(admin, id, shop);
    const numericId = id.includes("/") ? id.split("/").pop()! : id;
    customerStateCache.del(`cs:${shop}:${numericId}`);
    catalogIdsCache.del(`cids:${shop}:${numericId}`);
    return json({ success: true, intent: "refresh-metafield" });
  }

  if (intent === "update-tags") {
    const tagsStr = formData.get("tags")?.toString() ?? "";
    const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const numericId = id.includes("/") ? id.split("/").pop()! : id;
    const customerGid = `gid://shopify/Customer/${numericId}`;

    const res = await admin.graphql(
      `mutation UpdateTags($id: ID!, $tags: [String!]!) {
        customerUpdate(input: { id: $id, tags: $tags }) {
          customer { id tags }
          userErrors { field message }
        }
      }`,
      { variables: { id: customerGid, tags } }
    );
    const data = await res.json();
    const errors = data?.data?.customerUpdate?.userErrors ?? [];
    if (errors.length) {
      return json({ success: false, intent: "update-tags", error: errors.map((e: any) => e.message).join(", ") });
    }

    // Re-check segments and auto-update all catalog assignments
    const segments = await db.segment.findMany({
      where: { status: "Active" },
      select: { id: true, customercondition: true },
    });
    const matchedSegments = segments.filter((s) => {
      const cond = s.customercondition ?? "";
      if (cond.startsWith("domain:")) return false;
      const tag = cond.startsWith("tag:") ? cond.slice(4) : cond;
      return tags.includes(tag);
    });
    const assignedIds: number[] = [];
    for (const seg of matchedSegments) {
      const cats = await db.catalog.findMany({
        where: { segmentId: seg.id, status: "active" },
        select: { id: true },
      });
      cats.forEach((c: any) => { if (!assignedIds.includes(c.id)) assignedIds.push(c.id); });
    }
    if (assignedIds.length > 0) {
      await db.$executeRaw`DELETE FROM customer_catalogs WHERE "customerId" = ${id}`;
      for (const catId of assignedIds) {
        await db.$executeRaw`INSERT INTO customer_catalogs ("customerId", "catalogId") VALUES (${id}, ${catId}) ON CONFLICT DO NOTHING`;
      }
      await db.customers.update({ where: { id }, data: { catalogId: assignedIds[0] } });
    }

    // Refresh metafield + bust cache if already approved
    const dbCustomer = await db.customers.findUnique({
      where: { id }, select: { applicationStatus: true, catalogId: true },
    });
    if (dbCustomer?.applicationStatus === "ACCEPTED" && dbCustomer?.catalogId) {
      const numericCid = id.includes("/") ? id.split("/").pop()! : id;
      customerStateCache.del(`cs:${shop}:${numericCid}`);
      catalogIdsCache.del(`cids:${shop}:${numericCid}`);
      await writeCustomerDiscountMetafield(admin, id, shop).catch(() => {});
    }

    return json({ success: true, intent: "update-tags" });
  }

  if (intent === "delete") {
    await clearCustomerDiscountMetafield(admin, id, shop).catch((err) =>
      console.error("[B2B] failed to clear metafield on delete:", err)
    );
    const customer = await db.customers.findUnique({
      where: { id },
      select: { shippingAddressId: true, billingAddressId: true },
    });
    await db.customers.delete({ where: { id } });
    if (customer?.shippingAddressId)
      await db.address.delete({ where: { id: customer.shippingAddressId } }).catch(() => {});
    if (customer?.billingAddressId && customer.billingAddressId !== customer.shippingAddressId)
      await db.address.delete({ where: { id: customer.billingAddressId } }).catch(() => {});
    return redirect("/app/customers");
  }

  const minimumAmountStr = formData.get("minimumOrderAmount")?.toString() ?? "";
  const parsedMinimum = parseFloat(minimumAmountStr);
  const minimumOrderCents =
    minimumAmountStr === "" || isNaN(parsedMinimum) || parsedMinimum <= 0
      ? null
      : Math.round(parsedMinimum * 100);

  const updateData: any = {
    firstName: formData.get("firstName")?.toString() || null,
    lastName: formData.get("lastName")?.toString() || null,
    email: formData.get("email")?.toString() || null,
    businessName: formData.get("businessName")?.toString() || null,
    taxId: formData.get("taxId")?.toString() || null,
    minimumOrderCents,
  };

  if (intent === "approve") {
    updateData.applicationStatus = "ACCEPTED";
    try {
      const numericId = id.includes("/") ? id.split("/").pop()! : id;
      const customerGid = `gid://shopify/Customer/${numericId}`;

      // Fetch current tags
      const tagRes = await admin.graphql(
        `query { customer(id: "${customerGid}") { tags } }`
      );
      const existingTags: string[] = (await tagRes.json())?.data?.customer?.tags ?? [];

      // Find all active catalogs with tag-based segments for this shop
      const segments = await db.segment.findMany({
        where: { status: "Active" },
        select: { id: true, customercondition: true },
      });

      // Collect which tags need to be added and which catalogs to enroll in
      const tagsToAdd: string[] = [];
      const assignedIds: number[] = [];

      for (const seg of segments) {
        const cond = seg.customercondition ?? "";
        if (cond.startsWith("domain:") || cond.startsWith("customers:") || cond.startsWith("shopify_segment:")) continue;
        const tag = cond.startsWith("tag:") ? cond.slice(4) : cond;
        if (!tag) continue;

        const cats = await db.catalog.findMany({
          where: { segmentId: seg.id, status: "active", shopDomain: shop },
          select: { id: true },
        });
        if (!cats.length) continue;

        // Push tag to Shopify if customer doesn't have it yet
        if (!existingTags.includes(tag) && !tagsToAdd.includes(tag)) tagsToAdd.push(tag);
        cats.forEach((c: any) => { if (!assignedIds.includes(c.id)) assignedIds.push(c.id); });
      }

      // Add missing tags to customer in Shopify
      if (tagsToAdd.length > 0) {
        await admin.graphql(
          `mutation TagAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { variables: { id: customerGid, tags: tagsToAdd } }
        );
        console.log(`[B2B] pushed tags ${JSON.stringify(tagsToAdd)} to ${customerGid} on approve`);
      }

      if (assignedIds.length > 0) {
        await db.$executeRaw`DELETE FROM customer_catalogs WHERE "customerId" = ${id}`;
        for (const catId of assignedIds) {
          await db.$executeRaw`INSERT INTO customer_catalogs ("customerId", "catalogId") VALUES (${id}, ${catId}) ON CONFLICT DO NOTHING`;
        }
        updateData.catalogId = assignedIds[0];
      }
    } catch (err) {
      console.error("[B2B] auto-assign catalog failed:", err);
    }
  }
  if (intent === "reject") {
    updateData.applicationStatus = "REJECTED";
    updateData.catalogId = null;
    await db.$executeRaw`DELETE FROM customer_catalogs WHERE "customerId" = ${id}`;
  }

  const updated = await db.customers.update({
    where: { id },
    data: updateData,
    select: { applicationStatus: true, catalogId: true },
  });

  // Bust both caches so the storefront picks up the new catalog immediately
  const numericId2 = id.includes("/") ? id.split("/").pop()! : id;
  customerStateCache.del(`cs:${shop}:${numericId2}`);
  catalogIdsCache.del(`cids:${shop}:${numericId2}`);

  if (updated.applicationStatus === "ACCEPTED") {
    await writeCustomerDiscountMetafield(admin, id, shop).catch((err) =>
      console.error("[B2B] failed to write discount metafield:", err)
    );
  } else {
    await clearCustomerDiscountMetafield(admin, id, shop).catch((err) =>
      console.error("[B2B] failed to clear discount metafield:", err)
    );
  }

  // Send customer email on approve/reject (fire-and-forget)
  if (intent === "approve" || intent === "reject") {
    const customerEmail = updateData.email
      || (await db.customers.findUnique({ where: { id }, select: { email: true } }))?.email;
    const formSettings = await db.form.findFirst({
      where: { shopDomain: shop },
      select: {
        resendApiKey:          true,
        acceptedMessage:       true,
        rejectedMessage:       true,
        emailFromName:         true,
        emailFromAddress:      true,
        emailAccentColor:      true,
        emailApprovedSubject:  true,
        emailApprovedBody:     true,
        emailRejectedSubject:  true,
        emailRejectedBody:     true,
        emailApprovedBlocks:   true,
        emailRejectedBlocks:   true,
      },
    });
    console.log("[B2B] customer email check:", { intent, email: customerEmail || "(none)", hasApiKey: !!formSettings?.resendApiKey });
    if (customerEmail && formSettings?.resendApiKey) {
      const apiKey   = formSettings.resendApiKey as string;
      const fromName   = (formSettings.emailFromName    as string) || "B2B Wholesale";
      const fromAddr   = (formSettings.emailFromAddress as string) || "";
      const from       = fromAddr ? `${fromName} <${fromAddr}>` : undefined;
      const accent     = (formSettings.emailAccentColor as string) || "#303030";
      const custName   = `${updateData.firstName || ""} ${updateData.lastName || ""}`.trim() || "Valued customer";

      if (intent === "approve") {
        const subject = (formSettings.emailApprovedSubject as string) || "Your wholesale application has been approved";
        const approvedBlocks = parseEmailBlocks((formSettings.emailApprovedBlocks as string) || "[]");
        const html = approvedBlocks.length > 0
          ? renderEmailBlocks(approvedBlocks, { customerName: custName, shopName: shop })
          : approvedHtml({ customerName: custName, shopName: shop, message: (formSettings.emailApprovedBody as string) || (formSettings.acceptedMessage as string) || "Your wholesale account is approved and active.", shopUrl: `https://${shop}`, fromName, accentColor: accent });
        sendEmail({ apiKey, to: customerEmail, subject, shopDomain: shop, html, from }).catch((err) => console.error("[B2B] approved email failed:", err));
      } else {
        const subject = (formSettings.emailRejectedSubject as string) || "Update on your wholesale application";
        const rejectedBlocks = parseEmailBlocks((formSettings.emailRejectedBlocks as string) || "[]");
        const html = rejectedBlocks.length > 0
          ? renderEmailBlocks(rejectedBlocks, { customerName: custName, shopName: shop })
          : rejectedHtml({ customerName: custName, shopName: shop, message: (formSettings.emailRejectedBody as string) || (formSettings.rejectedMessage as string) || "Unfortunately your application wasn't approved at this time.", fromName, accentColor: accent });
        sendEmail({ apiKey, to: customerEmail, subject, shopDomain: shop, html, from }).catch((err) => console.error("[B2B] rejected email failed:", err));
      }
    }
  }

  return json({ success: true, intent });
};

// ── Status helpers ────────────────────────────────────────────────────────────
const statusConfig: Record<string, { tone: "success" | "critical" | "attention"; label: string; bg: string; color: string }> = {
  ACCEPTED: { tone: "success", label: "Approved", bg: "#f0fdf4", color: "#166534" },
  REJECTED: { tone: "critical", label: "Rejected", bg: "#fef2f2", color: "#991b1b" },
  PENDING:  { tone: "attention", label: "Pending", bg: "#fffbeb", color: "#92400e" },
};

export default function CustomerPage() {
  const { customer, autoSegment, autoCatalogs, assignedCatalogs, customerTags, segmentTags } = useLoaderData<typeof loader>();
  const fetcher     = useFetcher<typeof action>();
  const tagsFetcher = useFetcher<typeof action>();

  const [firstName, setFirstName]       = useState(customer.firstName || "");
  const [lastName, setLastName]         = useState(customer.lastName || "");
  const [email, setEmail]               = useState(customer.email || "");
  const [businessName, setBusinessName] = useState(customer.businessName || "");
  const [taxId, setTaxId]               = useState(customer.taxId || "");
  const [minimumOrderAmount, setMinimumOrderAmount] = useState(
    customer.minimumOrderCents ? String((customer.minimumOrderCents / 100).toFixed(2)) : ""
  );
  const [tags, setTags]       = useState<string[]>(customerTags);
  const [tagInput, setTagInput] = useState("");

  const isSaving = fetcher.state === "submitting";
  const saved = fetcher.data?.success;
  const tagsSaved = tagsFetcher.data?.intent === "update-tags" && tagsFetcher.data?.success;

  const addTag = (value?: string) => {
    const tag = (value ?? tagInput).trim();
    if (!tag || tags.includes(tag)) return;
    setTags((prev) => [...prev, tag]);
    setTagInput("");
  };

  const removeTag = (tag: string) => setTags((prev) => prev.filter((t) => t !== tag));

  const saveTags = () => {
    tagsFetcher.submit(
      { intent: "update-tags", tags: tags.join(",") },
      { method: "post" }
    );
  };
  const cfg = statusConfig[customer.applicationStatus] ?? statusConfig.PENDING;

  const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || "Unnamed Customer";
  const initials = `${(customer.firstName || "?")[0]}${(customer.lastName || "")[0] || ""}`.toUpperCase();

  const submit = (intent: string) => {
    fetcher.submit(
      { intent, firstName, lastName, email, businessName, taxId, minimumOrderAmount },
      { method: "post" }
    );
  };

  const handleDelete = () => {
    if (confirm("Permanently delete this customer?")) {
      fetcher.submit({ intent: "delete" }, { method: "post" });
    }
  };

  return (
    <Page backAction={{ content: "Customers", url: "/app/customers" }} title="">
      <BlockStack gap="500">

        {/* ── Hero header ── */}
        <Box
          background="bg-fill"
          borderRadius="300"
          padding="600"
          borderWidth="025"
          borderColor="border"
        >
          <InlineStack gap="400" align="space-between" blockAlign="center">
            <InlineStack gap="400" blockAlign="center">
              {/* Avatar */}
              <div style={{
                width: 60, height: 60, borderRadius: "50%",
                background: cfg.bg, border: `2px solid ${cfg.color}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, fontWeight: 700, color: cfg.color, flexShrink: 0,
              }}>
                {initials}
              </div>
              <BlockStack gap="050">
                <Text as="h1" variant="headingXl">{fullName}</Text>
                <InlineStack gap="200">
                  {customer.email && <Text as="span" tone="subdued">{customer.email}</Text>}
                  {customer.businessName && (
                    <>
                      <Text as="span" tone="subdued">·</Text>
                      <Text as="span" tone="subdued">{customer.businessName}</Text>
                    </>
                  )}
                </InlineStack>
              </BlockStack>
            </InlineStack>
            <InlineStack gap="300" blockAlign="center">
              <Badge tone={cfg.tone} size="large">{cfg.label}</Badge>
              {customer.applicationDate && (
                <Text as="span" tone="subdued">
                  Applied {new Date(customer.applicationDate).toLocaleDateString()}
                </Text>
              )}
            </InlineStack>
          </InlineStack>
        </Box>

        {saved && (
          <Banner tone="success">
            {fetcher.data?.intent === "approve"
              ? "Customer approved — wholesale pricing is now active."
              : fetcher.data?.intent === "reject"
              ? "Customer rejected and wholesale access removed."
              : "Changes saved."}
          </Banner>
        )}
        {tagsSaved && (
          <Banner tone="success">
            Tags saved to Shopify.
            {autoCatalogs.length > 0
              ? ` Catalogs matched: ${autoCatalogs.map((c) => c.title).join(", ")}.`
              : ""}
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, md: "2fr 1fr" }} gap="500">
          {/* ── Left column ── */}
          <BlockStack gap="500">

            {/* Personal info */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Personal information</Text>
                <Divider />
                <InlineGrid columns={2} gap="400">
                  <TextField label="First name" value={firstName} onChange={setFirstName} autoComplete="off" />
                  <TextField label="Last name" value={lastName} onChange={setLastName} autoComplete="off" />
                </InlineGrid>
                <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
              </BlockStack>
            </Card>

            {/* Business info */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Business information</Text>
                <Divider />
                <InlineGrid columns={2} gap="400">
                  <TextField label="Business name" value={businessName} onChange={setBusinessName} autoComplete="off" />
                  <TextField label="Tax ID / VAT" value={taxId} onChange={setTaxId} autoComplete="off" />
                </InlineGrid>
              </BlockStack>
            </Card>

            {/* Customer tags */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Customer tags</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Tags are synced to Shopify. Adding a segment tag here auto-assigns the linked catalog when the customer is approved.
                </Text>
                <Divider />

                {/* Current tags */}
                {tags.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {tags.map((tag) => (
                      <Tag key={tag} onRemove={() => removeTag(tag)}>{tag}</Tag>
                    ))}
                  </div>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">No tags yet.</Text>
                )}

                {/* Segment tag suggestions */}
                {segmentTags.filter((t) => !tags.includes(t)).length > 0 && (
                  <BlockStack gap="150">
                    <Text as="p" variant="bodySm" tone="subdued">Quick-add segment tags:</Text>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {segmentTags.filter((t) => !tags.includes(t)).map((t) => (
                        <button
                          key={t}
                          onClick={() => addTag(t)}
                          style={{
                            background: "#f3f4f6", border: "1px solid #d1d5db",
                            borderRadius: 20, padding: "3px 10px", fontSize: 12,
                            cursor: "pointer", color: "#374151", fontWeight: 500,
                          }}
                        >
                          + {t}
                        </button>
                      ))}
                    </div>
                  </BlockStack>
                )}

                {/* Add custom tag */}
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Add tag"
                      value={tagInput}
                      onChange={setTagInput}
                      autoComplete="off"
                      placeholder="Type a tag…"
                      onKeyPress={(e: any) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                    />
                  </div>
                  <Button onClick={() => addTag()} disabled={!tagInput.trim()}>Add</Button>
                </InlineStack>

                {(tagsSaved) && (
                  <Banner tone="success">Tags saved to Shopify.</Banner>
                )}
                {tagsFetcher.data?.error && (
                  <Banner tone="critical">{tagsFetcher.data.error as string}</Banner>
                )}

                <Button
                  variant="primary"
                  loading={tagsFetcher.state === "submitting"}
                  onClick={saveTags}
                  disabled={JSON.stringify(tags.sort()) === JSON.stringify([...customerTags].sort())}
                >
                  Save tags to Shopify
                </Button>
              </BlockStack>
            </Card>

            {/* Addresses */}
            {(customer.shippingAddress || customer.billingAddress) && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Addresses</Text>
                  <Divider />
                  <InlineGrid columns={2} gap="400">
                    {customer.shippingAddress && (
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm" tone="subdued">SHIPPING</Text>
                        <Text as="p">{customer.shippingAddress.street}</Text>
                        <Text as="p">{customer.shippingAddress.city}, {customer.shippingAddress.zip}</Text>
                        <Text as="p">{customer.shippingAddress.country}</Text>
                      </BlockStack>
                    )}
                    {customer.billingAddress && (
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm" tone="subdued">BILLING</Text>
                        <Text as="p">{customer.billingAddress.street}</Text>
                        <Text as="p">{customer.billingAddress.city}, {customer.billingAddress.zip}</Text>
                        <Text as="p">{customer.billingAddress.country}</Text>
                      </BlockStack>
                    )}
                  </InlineGrid>
                </BlockStack>
              </Card>
            )}
          </BlockStack>

          {/* ── Right column ── */}
          <BlockStack gap="500">

            {/* Wholesale access */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Wholesale access</Text>
                <Divider />

                {/* Auto-detected segment & catalog */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm" tone="subdued">SEGMENT</Text>
                  {autoSegment ? (
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone="info">{autoSegment.title}</Badge>
                      <Text as="span" tone="subdued" variant="bodySm">matched by customer tag</Text>
                    </InlineStack>
                  ) : (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No segment matched. Add the appropriate tag to this customer in Shopify.
                    </Text>
                  )}
                </BlockStack>

                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm" tone="subdued">CATALOGS</Text>
                  {assignedCatalogs.length > 0 ? (
                    <BlockStack gap="150">
                      {assignedCatalogs.map((cat) => (
                        <div key={cat.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={cat.status === "active" ? "success" : "attention"}>{cat.title}</Badge>
                          </InlineStack>
                          <Button variant="plain" url={`/app/catalogs/${cat.id}`}>Open →</Button>
                        </div>
                      ))}
                    </BlockStack>
                  ) : autoCatalogs.length > 0 ? (
                    <BlockStack gap="150">
                      {autoCatalogs.map((cat) => (
                        <Badge key={cat.id} tone="success">{cat.title}</Badge>
                      ))}
                      <Text as="p" tone="subdued" variant="bodySm">
                        {autoCatalogs.length === 1 ? "This catalog" : "These catalogs"} will be assigned on approval.
                      </Text>
                    </BlockStack>
                  ) : (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No catalogs linked. Link a catalog to this customer's segment, then re-approve.
                    </Text>
                  )}
                </BlockStack>

                <Divider />

                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm" tone="subdued">ACTIONS</Text>
                  <Button
                    variant="primary" tone="success" fullWidth
                    loading={isSaving && fetcher.formData?.get("intent") === "approve"}
                    onClick={() => submit("approve")}
                  >
                    {customer.applicationStatus === "ACCEPTED" ? "Re-approve" : "Approve & activate wholesale"}
                  </Button>
                  <Button
                    tone="critical" fullWidth
                    loading={isSaving && fetcher.formData?.get("intent") === "reject"}
                    disabled={customer.applicationStatus === "REJECTED"}
                    onClick={() => submit("reject")}
                  >
                    Revoke access
                  </Button>
                  {customer.applicationStatus === "ACCEPTED" && (
                    <Button
                      fullWidth
                      loading={isSaving && fetcher.formData?.get("intent") === "refresh-metafield"}
                      onClick={() => submit("refresh-metafield")}
                    >
                      Sync cart prices
                    </Button>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Order settings */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Order settings</Text>
                <Divider />
                <TextField
                  label="Minimum order amount"
                  type="number"
                  value={minimumOrderAmount}
                  onChange={setMinimumOrderAmount}
                  autoComplete="off"
                  prefix="€"
                  helpText="Overrides the global minimum if higher."
                />
              </BlockStack>
            </Card>

            {/* Save / Delete */}
            <Card>
              <BlockStack gap="300">
                <Button
                  variant="primary"
                  fullWidth
                  loading={isSaving && fetcher.formData?.get("intent") === "save"}
                  onClick={() => submit("save")}
                >
                  Save changes
                </Button>
                <Button tone="critical" fullWidth onClick={handleDelete}>
                  Delete customer
                </Button>
              </BlockStack>
            </Card>

          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
