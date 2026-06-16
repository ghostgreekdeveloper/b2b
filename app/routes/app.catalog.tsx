import React, { useState, useCallback } from "react";
import { PlusIcon } from "@shopify/polaris-icons";
import {
  Page, Card, Button, Modal, BlockStack, InlineStack, InlineGrid,
  IndexTable, useIndexResourceState, useBreakpoints, TextField,
  Text, Badge, Link, Box, Checkbox, Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useLoaderData, useFetcher } from "@remix-run/react";
import type { LoaderArgs, ActionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderArgs) => {
  await authenticate.admin(request);
  const catalogs = await db.catalog.findMany({
    select: {
      id: true,
      title: true,
      status: true,
      defaultDiscountPercent: true,
      autoIncludeProducts: true,
      segmentId: true,
      createdAt: true,
      _count: { select: { items: true, customers: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const segments = await db.segment.findMany({ select: { id: true, title: true } });

  return json({ catalogs, segments });
};

export const action = async ({ request }: ActionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const title = formData.get("title")?.toString() || "Untitled Catalog";
  const autoIncludeProducts = formData.get("autoIncludeProducts") === "on";

  const newCatalog = await db.catalog.create({
    data: { shopDomain: session.shop, title, tag: "", defaultDiscountPercent: null, autoIncludeProducts },
  });

  if (autoIncludeProducts) {
    const allProducts: any[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const res = await admin.graphql(
        `#graphql
        query GetProducts($cursor: String) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              id title featuredImage { url }
              variants(first: 100) { edges { node { id sku price image { url } } } }
            } }
          }
        }`,
        { variables: { cursor } }
      );
      const data = await res.json();
      const products = data?.data?.products;
      allProducts.push(...(products?.edges ?? []).map((e: any) => e.node));
      hasNextPage = products?.pageInfo?.hasNextPage ?? false;
      cursor = products?.pageInfo?.endCursor ?? null;
    }

    const catalogItemsData = allProducts.flatMap((product: any) =>
      (product.variants?.edges ?? []).map((ve: any) => {
        const variant = ve.node;
        return {
          catalogId: newCatalog.id,
          productId: product.id.replace("gid://shopify/Product/", ""),
          variantId: variant.id.replace("gid://shopify/ProductVariant/", ""),
          sku: variant.sku || undefined,
          name: product.title || "Unnamed Product",
          img: variant.image?.url || product.featuredImage?.url || "",
          customPriceCents: variant.price ? Math.round(parseFloat(variant.price) * 100) : undefined,
          customDiscountPercent: null,
        };
      })
    );
    if (catalogItemsData.length > 0) await db.catalogItem.createMany({ data: catalogItemsData });
  }

  return json({ catalog: newCatalog });
};

const statusConfig = {
  active:   { tone: "success"   as const, label: "Active"   },
  draft:    { tone: "attention" as const, label: "Draft"    },
  inactive: { tone: "critical"  as const, label: "Inactive" },
};

export default function CatalogsListPage() {
  const { catalogs, segments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [query, setQuery]       = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("New Catalog");
  const [autoInclude, setAutoInclude] = useState(false);

  const segmentMap = Object.fromEntries(segments.map((s: any) => [s.id, s.title]));

  const filtered = catalogs.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase())
  );

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(filtered);

  const create = () => {
    fetcher.submit(
      { title: newTitle || "New Catalog", autoIncludeProducts: autoInclude ? "on" : "" },
      { method: "post" }
    );
    setModalOpen(false);
  };

  const rowMarkup = filtered.map((catalog, index) => {
    const cfg = statusConfig[(catalog.status as keyof typeof statusConfig) ?? "active"] ?? statusConfig.active;
    return (
      <IndexTable.Row
        id={String(catalog.id)}
        key={catalog.id}
        selected={selectedResources.includes(String(catalog.id))}
        position={index}
      >
        <IndexTable.Cell>
          <Link dataPrimaryLink url={`/app/catalogs/${catalog.id}`}>
            <Text fontWeight="bold" as="span">{catalog.title}</Text>
          </Link>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={cfg.tone}>{cfg.label}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {catalog.segmentId && segmentMap[catalog.segmentId] ? (
            <Badge tone="info">{segmentMap[catalog.segmentId]}</Badge>
          ) : (
            <Text as="span" tone="subdued">—</Text>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">
            {catalog.defaultDiscountPercent ? `-${catalog.defaultDiscountPercent}%` : "—"}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{catalog._count.items}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{catalog._count.customers}</Text>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  const activeCount   = catalogs.filter((c) => c.status === "active").length;
  const totalProducts = catalogs.reduce((sum, c) => sum + c._count.items, 0);

  return (
    <Page title="">
      <BlockStack gap="600">

        {/* ── Dark hero banner ── */}
        <div style={{
          position: "relative", overflow: "hidden", borderRadius: 16,
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)",
          padding: "28px 32px",
          boxShadow: "0 20px 60px rgba(15,23,42,0.18)",
        }}>
          <div style={{ position: "absolute", top: -50, right: -50, width: 220, height: 220, borderRadius: "50%", background: "radial-gradient(circle, #6366f130 0%, transparent 70%)", pointerEvents: "none" }} />
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
              <div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "3px 12px", marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Price catalogs</span>
                </div>
                <h1 style={{ margin: 0, fontSize: 28, fontWeight: 750, color: "#f8fafc", letterSpacing: "-0.03em" }}>Catalogs</h1>
              </div>
              <Button variant="primary" icon={PlusIcon} onClick={() => setModalOpen(true)}>
                Create catalog
              </Button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {[
                { label: "Total", value: catalogs.length, icon: "▦" },
                { label: "Active", value: activeCount, icon: "◉" },
                { label: "Products", value: totalProducts, icon: "◈" },
              ].map((s) => (
                <div key={s.label} style={{ background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>{s.icon} {s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 750, color: "#f1f5f9", letterSpacing: "-0.02em" }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Card padding="0">
          <Box padding="400" borderBlockEndWidth="025" borderColor="border">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">All catalogs</Text>
              <div style={{ width: 260 }}>
                <TextField
                  label="" labelHidden
                  value={query}
                  onChange={setQuery}
                  placeholder="Search catalogs…"
                  autoComplete="off"
                />
              </div>
            </InlineStack>
          </Box>

          <IndexTable
            condensed={useBreakpoints().smDown}
            resourceName={{ singular: "catalog", plural: "catalogs" }}
            itemCount={filtered.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            headings={[
              { title: "Catalog" },
              { title: "Status" },
              { title: "Segment" },
              { title: "Discount" },
              { title: "Products" },
              { title: "Customers" },
            ]}
            emptyState={
              <Box padding="800">
                <BlockStack gap="300" align="center">
                  <Text as="p" variant="bodyLg" tone="subdued">No catalogs yet</Text>
                  <Button variant="primary" icon={PlusIcon} onClick={() => setModalOpen(true)}>
                    Create your first catalog
                  </Button>
                </BlockStack>
              </Box>
            }
          >
            {rowMarkup}
          </IndexTable>
        </Card>
      </BlockStack>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create catalog"
        primaryAction={{ content: "Create", onAction: create, loading: fetcher.state === "submitting" }}
        secondaryActions={[{ content: "Cancel", onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Catalog title"
              value={newTitle}
              onChange={setNewTitle}
              placeholder="e.g. VIP Wholesale"
              autoComplete="off"
            />
            <Divider />
            <Checkbox
              label="Auto-include all existing products"
              helpText="Imports all Shopify products into this catalog immediately."
              checked={autoInclude}
              onChange={setAutoInclude}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
