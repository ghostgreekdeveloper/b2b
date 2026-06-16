import React, { useState } from "react";
import { PlusIcon } from "@shopify/polaris-icons";
import {
  Page, Button, Modal, BlockStack, TextField, Checkbox, Divider, Select, Text, InlineStack, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { customerStateCache } from "../cache.server";
import { useLoaderData, useFetcher, Link } from "@remix-run/react";
import type { LoaderArgs, ActionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";

export const loader = async ({ request }: LoaderArgs) => {
  await authenticate.admin(request);
  const catalogs = await db.catalog.findMany({
    select: {
      id: true, title: true, status: true,
      defaultDiscountPercent: true, autoIncludeProducts: true, segmentId: true, createdAt: true,
      discountType: true, fixedDiscountCents: true, fixedPriceCents: true, priceDisplay: true,
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
  const intent = formData.get("_action")?.toString();

  if (intent === "delete") {
    const catalogId = Number(formData.get("catalogId"));
    if (!catalogId) return json({ error: "missing catalogId" }, { status: 400 });
    // Detach customers, clear junction table, delete items, delete catalog
    await db.customers.updateMany({ where: { catalogId }, data: { catalogId: null } });
    await db.$executeRaw`DELETE FROM customer_catalogs WHERE catalogId = ${catalogId}`;
    await db.catalogItem.deleteMany({ where: { catalogId } });
    await db.catalog.delete({ where: { id: catalogId } });
    customerStateCache.delPrefix(`cs:${session.shop}:`);
    return json({ success: true, intent: "delete" });
  }

  const title = formData.get("title")?.toString() || "Untitled Catalog";
  const autoIncludeProducts = formData.get("autoIncludeProducts") === "on";
  const discountType = formData.get("discountType")?.toString() || "PERCENT";
  const priceDisplay = formData.get("priceDisplay")?.toString() || "REPLACED";
  const fixedDiscountCentsRaw = formData.get("fixedDiscountCents")?.toString();
  const fixedPriceCentsRaw = formData.get("fixedPriceCents")?.toString();
  const fixedDiscountCents = discountType === "FIXED_AMOUNT" && fixedDiscountCentsRaw
    ? Math.round(parseFloat(fixedDiscountCentsRaw) * 100) : null;
  const fixedPriceCents = discountType === "FIXED_PRICE" && fixedPriceCentsRaw
    ? Math.round(parseFloat(fixedPriceCentsRaw) * 100) : null;

  const segmentIdRaw = formData.get("segmentId")?.toString() || null;

  const newCatalog = await db.catalog.create({
    data: {
      shopDomain: session.shop, title, tag: "",
      defaultDiscountPercent: null, autoIncludeProducts,
      discountType, priceDisplay,
      fixedDiscountCents, fixedPriceCents,
      segmentId: segmentIdRaw || null,
    },
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
        const v = ve.node;
        return {
          catalogId: newCatalog.id,
          productId: product.id.replace("gid://shopify/Product/", ""),
          variantId: v.id.replace("gid://shopify/ProductVariant/", ""),
          sku: v.sku || undefined,
          name: product.title || "Unnamed Product",
          img: v.image?.url || product.featuredImage?.url || "",
          customPriceCents: v.price ? Math.round(parseFloat(v.price) * 100) : undefined,
          customDiscountPercent: null,
        };
      })
    );
    if (catalogItemsData.length > 0) await db.catalogItem.createMany({ data: catalogItemsData });
  }

  return json({ catalog: newCatalog });
};

// ── Status styles ─────────────────────────────────────────────────────────────
const STATUS = {
  active:   { label: "Active",   bg: "#f0fdf4", color: "#15803d", border: "#86efac", dot: "#22c55e" },
  draft:    { label: "Draft",    bg: "#fefce8", color: "#854d0e", border: "#fde047", dot: "#facc15" },
  inactive: { label: "Inactive", bg: "#f8fafc", color: "#64748b", border: "#e2e8f0", dot: "#94a3b8" },
} as const;

// ── Component ─────────────────────────────────────────────────────────────────
export default function CatalogsListPage() {
  const { catalogs, segments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const segmentMap = Object.fromEntries(segments.map((s: any) => [s.id, s.title]));

  const [tab, setTab]         = useState<"all" | "active" | "draft" | "inactive">("all");
  const [search, setSearch]   = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [newTitle, setNewTitle]         = useState("");
  const [autoInclude, setAutoInclude]   = useState(false);
  const [discountType, setDiscountType] = useState("PERCENT");
  const [priceDisplay, setPriceDisplay] = useState("REPLACED");
  const [fixedDiscountAmount, setFixedDiscountAmount] = useState("");
  const [fixedPriceAmount, setFixedPriceAmount]       = useState("");
  const [percentAmount, setPercentAmount]             = useState("");
  const [newSegmentId, setNewSegmentId]               = useState("");

  const counts = {
    all:      catalogs.length,
    active:   catalogs.filter((c) => c.status === "active").length,
    draft:    catalogs.filter((c) => c.status === "draft").length,
    inactive: catalogs.filter((c) => c.status === "inactive").length,
  };

  const filtered = catalogs.filter((c) => {
    const q = search.toLowerCase();
    const matchQ = !q || c.title.toLowerCase().includes(q);
    const matchT = tab === "all" || c.status === tab;
    return matchQ && matchT;
  });

  const confirmDelete = () => {
    if (!deletingId) return;
    fetcher.submit({ _action: "delete", catalogId: String(deletingId) }, { method: "post" });
    setDeletingId(null);
  };

  const create = () => {
    fetcher.submit(
      {
        title: newTitle || "New Catalog",
        autoIncludeProducts: autoInclude ? "on" : "",
        discountType,
        priceDisplay,
        segmentId: newSegmentId,
        fixedDiscountCents: discountType === "FIXED_AMOUNT" ? fixedDiscountAmount : "",
        fixedPriceCents: discountType === "FIXED_PRICE" ? fixedPriceAmount : "",
      },
      { method: "post" }
    );
    setModalOpen(false);
    setNewTitle(""); setAutoInclude(false);
    setDiscountType("PERCENT"); setPriceDisplay("REPLACED");
    setFixedDiscountAmount(""); setFixedPriceAmount(""); setPercentAmount("");
    setNewSegmentId("");
  };

  const TABS = [
    { key: "all"      as const, label: "All" },
    { key: "active"   as const, label: "Active" },
    { key: "draft"    as const, label: "Draft" },
    { key: "inactive" as const, label: "Inactive" },
  ];

  return (
    <Page title="">
      <BlockStack gap="600">

        {/* ── Dark hero banner ── */}
        <div style={{
          position: "relative", overflow: "hidden", borderRadius: 16,
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)",
          padding: "28px 32px", boxShadow: "0 20px 60px rgba(15,23,42,0.18)",
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
              {[
                { label: "Total",    value: catalogs.length,                                                    icon: "▦" },
                { label: "Active",   value: counts.active,                                                      icon: "◉" },
                { label: "Products", value: catalogs.reduce((s, c) => s + c._count.items, 0),                   icon: "◈" },
              ].map((s) => (
                <div key={s.label} style={{ background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>{s.icon} {s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 750, color: "#f1f5f9", letterSpacing: "-0.02em" }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Table card ── */}
        <div style={{
          background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflow: "hidden",
        }}>

          {/* Toolbar */}
          <div style={{
            padding: "14px 20px", background: "#fafafa", borderBottom: "1px solid #f1f5f9",
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          }}>
            {/* Tab strip */}
            <div style={{ display: "flex", gap: 4, background: "#f1f5f9", borderRadius: 8, padding: 3 }}>
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  style={{
                    padding: "5px 14px", borderRadius: 6, border: "none",
                    background: tab === t.key ? "#fff" : "transparent",
                    color: tab === t.key ? "#0f172a" : "#64748b",
                    fontWeight: tab === t.key ? 700 : 500,
                    fontSize: 13, cursor: "pointer", fontFamily: "inherit",
                    boxShadow: tab === t.key ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                    transition: "all 0.12s",
                  }}
                >
                  {t.label}
                  <span style={{ marginLeft: 6, fontSize: 11, color: tab === t.key ? "#6366f1" : "#94a3b8", fontWeight: 700 }}>
                    {counts[t.key]}
                  </span>
                </button>
              ))}
            </div>

            {/* Search */}
            <div style={{ flex: 1, minWidth: 180, position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", pointerEvents: "none", fontSize: 14 }}>⌕</span>
              <input
                type="text"
                placeholder="Search catalogs…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "8px 12px 8px 32px", border: "1px solid #e2e8f0",
                  borderRadius: 8, fontSize: 13, color: "#0f172a",
                  fontFamily: "inherit", outline: "none", background: "#fff",
                }}
              />
            </div>

            <div style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap" }}>
              {filtered.length} of {catalogs.length}
            </div>
          </div>

          {/* Column headers */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,2.5fr) minmax(0,1.2fr) 80px 80px 80px 90px 40px",
            columnGap: 16, padding: "9px 20px",
            background: "#f9fafb", borderBottom: "1px solid #e5e7eb",
          }}>
            {["Catalog", "Program", "Discount", "Products", "Customers", "Status", ""].map((h) => (
              <div key={h} style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          {filtered.length === 0 && (
            <div style={{ padding: "52px 24px", textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>▦</div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#475569", marginBottom: 4 }}>
                {catalogs.length === 0 ? "No catalogs yet" : "No catalogs match"}
              </div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>
                {catalogs.length === 0 ? "Create your first price catalog to get started." : "Try adjusting your search or filter."}
              </div>
              {catalogs.length === 0 && (
                <button
                  onClick={() => setModalOpen(true)}
                  style={{
                    padding: "10px 22px", borderRadius: 8, background: "#0f172a", color: "#fff",
                    border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  + Create catalog
                </button>
              )}
            </div>
          )}

          {filtered.map((catalog, idx) => {
            const statusKey = (catalog.status ?? "inactive") as keyof typeof STATUS;
            const st = STATUS[statusKey] ?? STATUS.inactive;
            const programName = catalog.segmentId ? segmentMap[catalog.segmentId] : null;

            return (
              <Link
                key={catalog.id}
                to={`/app/catalogs/${catalog.id}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,2.5fr) minmax(0,1.2fr) 80px 80px 80px 90px 40px",
                    columnGap: 16, padding: "14px 20px", alignItems: "center",
                    borderBottom: idx < filtered.length - 1 ? "1px solid #f8fafc" : "none",
                    cursor: "pointer", transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  {/* Catalog name */}
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <div style={{
                      width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                      background: "linear-gradient(135deg, #f1f5f9, #e2e8f0)",
                      border: "1px solid #e2e8f0",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 18, color: "#94a3b8",
                    }}>▦</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontWeight: 650, fontSize: 14, color: "#0f172a",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {catalog.title}
                      </div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>
                        {catalog._count.items} variant{catalog._count.items !== 1 ? "s" : ""}
                        {catalog.autoIncludeProducts && (
                          <span style={{ marginLeft: 6, color: "#6366f1", fontWeight: 600 }}>· auto-include</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Program */}
                  <div>
                    {programName ? (
                      <span style={{
                        display: "inline-block", maxWidth: "100%",
                        padding: "3px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                        background: "#faf5ff", color: "#7c3aed", border: "1px solid #e9d5ff",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {programName}
                      </span>
                    ) : (
                      <span style={{ color: "#e2e8f0", fontSize: 14 }}>—</span>
                    )}
                  </div>

                  {/* Discount */}
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>
                    {(catalog as any).discountType === "FIXED_AMOUNT" ? (
                      <span style={{ color: "#0369a1" }}>−€{(((catalog as any).fixedDiscountCents ?? 0) / 100).toFixed(2)}</span>
                    ) : (catalog as any).discountType === "FIXED_PRICE" ? (
                      <span style={{ color: "#7c3aed" }}>€{(((catalog as any).fixedPriceCents ?? 0) / 100).toFixed(2)}</span>
                    ) : catalog.defaultDiscountPercent ? (
                      <span style={{ color: "#15803d" }}>-{catalog.defaultDiscountPercent}%</span>
                    ) : (
                      <span style={{ color: "#e2e8f0" }}>—</span>
                    )}
                  </div>

                  {/* Products */}
                  <div style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>
                    {catalog._count.items}
                  </div>

                  {/* Customers */}
                  <div style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>
                    {catalog._count.customers}
                  </div>

                  {/* Status badge */}
                  <div>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      padding: "4px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 700,
                      background: st.bg, color: st.color, border: `1px solid ${st.border}`,
                      whiteSpace: "nowrap",
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: st.dot, flexShrink: 0, boxShadow: `0 0 4px ${st.dot}80` }} />
                      {st.label}
                    </span>
                  </div>

                  {/* Delete */}
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <button
                      title="Delete catalog"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeletingId(catalog.id); }}
                      style={{
                        width: 30, height: 30, borderRadius: 6, border: "1px solid #fecaca",
                        background: "#fff5f5", color: "#dc2626", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, lineHeight: 1, fontFamily: "inherit",
                        transition: "all 0.12s",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#fee2e2"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#fff5f5"; }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </BlockStack>

      {/* Delete confirmation modal */}
      <Modal
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        title="Delete catalog?"
        primaryAction={{ content: "Delete", onAction: confirmDelete, destructive: true, loading: fetcher.state === "submitting" }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeletingId(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            This will permanently delete the catalog, all its products, and remove it from any assigned customers. This cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>

      {/* Create modal */}
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

            {/* Discount type — locked after creation */}
            <BlockStack gap="200">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="span" variant="bodyMd" fontWeight="semibold">Discount type</Text>
                <span style={{ fontSize: 11, background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", borderRadius: 10, padding: "2px 8px", fontWeight: 700 }}>
                  Locked after creation
                </span>
              </InlineStack>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[
                  { value: "PERCENT",      label: "% Off",          desc: "Discounted % for all",      icon: "%" },
                  { value: "FIXED_AMOUNT", label: "Fixed amount off", desc: "Decrease a fixed amount", icon: "−$" },
                  { value: "FIXED_PRICE",  label: "One price",       desc: "One price for all",         icon: "=$" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDiscountType(opt.value)}
                    style={{
                      flex: "1 1 120px", padding: "12px 10px", borderRadius: 10, cursor: "pointer",
                      border: discountType === opt.value ? "2px solid #6366f1" : "1px solid #e2e8f0",
                      background: discountType === opt.value ? "#f8f7ff" : "#fafafa",
                      textAlign: "left", fontFamily: "inherit",
                      boxShadow: discountType === opt.value ? "0 0 0 3px rgba(99,102,241,0.1)" : "none",
                      transition: "all 0.12s",
                    }}
                  >
                    <div style={{ fontSize: 18, marginBottom: 4 }}>{opt.icon}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: discountType === opt.value ? "#4f46e5" : "#0f172a" }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
              {discountType === "PERCENT" && (
                <TextField
                  label="Default discount %"
                  type="number"
                  value={percentAmount}
                  onChange={setPercentAmount}
                  placeholder="e.g. 20"
                  suffix="%"
                  autoComplete="off"
                  helpText="Applied to all products by default. Can be overridden per product."
                />
              )}
              {discountType === "FIXED_AMOUNT" && (
                <TextField
                  label="Fixed discount amount"
                  type="number"
                  value={fixedDiscountAmount}
                  onChange={setFixedDiscountAmount}
                  placeholder="e.g. 5.00"
                  prefix="€"
                  autoComplete="off"
                  helpText="This amount is deducted from the original price for all products."
                />
              )}
              {discountType === "FIXED_PRICE" && (
                <TextField
                  label="Fixed price"
                  type="number"
                  value={fixedPriceAmount}
                  onChange={setFixedPriceAmount}
                  placeholder="e.g. 49.99"
                  prefix="€"
                  autoComplete="off"
                  helpText="Every product in this catalog will be set to this one price."
                />
              )}
            </BlockStack>

            <Divider />

            {/* Price display */}
            <BlockStack gap="200">
              <Text as="span" variant="bodyMd" fontWeight="semibold">Price display (for non-wholesale visitors)</Text>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[
                  { value: "REPLACED",              label: "Price replaced",          desc: "Show wholesale price only",           icon: "⇄" },
                  { value: "ORIGINAL_AND_DISCOUNTED",label: "Original + discounted",   desc: "Show both prices with strikethrough", icon: "⊘" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setPriceDisplay(opt.value)}
                    style={{
                      flex: "1 1 120px", padding: "12px 10px", borderRadius: 10, cursor: "pointer",
                      border: priceDisplay === opt.value ? "2px solid #6366f1" : "1px solid #e2e8f0",
                      background: priceDisplay === opt.value ? "#f8f7ff" : "#fafafa",
                      textAlign: "left", fontFamily: "inherit",
                      boxShadow: priceDisplay === opt.value ? "0 0 0 3px rgba(99,102,241,0.1)" : "none",
                      transition: "all 0.12s",
                    }}
                  >
                    <div style={{ fontSize: 18, marginBottom: 4 }}>{opt.icon}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: priceDisplay === opt.value ? "#4f46e5" : "#0f172a" }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </BlockStack>

            <Divider />
            <Select
              label="Customer segment"
              options={[
                { label: "— none —", value: "" },
                ...(segments as { id: string; title: string }[]).map((s) => ({ label: s.title, value: s.id })),
              ]}
              value={newSegmentId}
              onChange={setNewSegmentId}
              helpText="Approved customers matching this segment get these prices automatically."
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
