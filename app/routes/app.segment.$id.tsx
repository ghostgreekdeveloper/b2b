/**
 * Buyer Program editor.
 * Supports 4 enrollment conditions:
 *   tag:TAGNAME            — customer has a Shopify tag
 *   domain:company.com     — customer email domain
 *   customers:ID1,ID2,...  — manually selected customers
 *   shopify_segment:GID    — native Shopify segment
 */
import { useState } from "react";
import {
  Page, Card, BlockStack, InlineStack, InlineGrid, Divider,
  Text, TextField, Button, Badge, Select, Banner, Box,
} from "@shopify/polaris";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { json, redirect } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { authenticate } from "../shopify.server";

type CondType = "tag" | "domain" | "customers" | "shopify_segment";

function parseCondition(raw: string | null): { type: CondType; value: string; customerIds: string[] } {
  const s = raw ?? "";
  if (s.startsWith("domain:"))          return { type: "domain",          value: s.slice(7), customerIds: [] };
  if (s.startsWith("tag:"))             return { type: "tag",             value: s.slice(4), customerIds: [] };
  if (s.startsWith("customers:"))       return { type: "customers",       value: "", customerIds: s.slice(10).split(",").filter(Boolean) };
  if (s.startsWith("shopify_segment:")) return { type: "shopify_segment", value: s.slice(17), customerIds: [] };
  return { type: "tag", value: s, customerIds: [] };
}

const COND_META: Record<CondType, { icon: string; color: string; bg: string; border: string; label: string }> = {
  tag:             { icon: "🏷", color: "#15803d", bg: "#f0fdf4", border: "#86efac", label: "Customer tag" },
  domain:          { icon: "✉",  color: "#1d4ed8", bg: "#eff6ff", border: "#93c5fd", label: "Email domain" },
  customers:       { icon: "👥", color: "#7c3aed", bg: "#faf5ff", border: "#d8b4fe", label: "Selected customers" },
  shopify_segment: { icon: "⬡",  color: "#c2410c", bg: "#fff7ed", border: "#fdba74", label: "Shopify segment" },
};

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const segmentId = params.id;
  if (!segmentId) throw new Error("Program ID is required");

  const segment = await db.segment.findUnique({ where: { id: segmentId } });
  if (!segment) throw new Response("Program not found", { status: 404 });

  const linkedCatalog = await db.catalog.findFirst({
    where: { segmentId },
    select: { id: true, title: true, status: true },
  });

  let uniqueTags: string[] = [];
  try {
    const res = await admin.graphql(`{ customers(first: 250) { edges { node { tags } } } }`);
    const d   = await res.json();
    const all: string[] = d?.data?.customers?.edges?.flatMap((e: any) => e.node.tags || []) || [];
    uniqueTags = Array.from(new Set<string>(all)).sort();
  } catch {}

  let shopifySegments: Array<{ id: string; name: string }> = [];
  try {
    const res = await admin.graphql(`query { segments(first: 50) { nodes { id name } } }`);
    const d   = await res.json();
    shopifySegments = d?.data?.segments?.nodes ?? [];
  } catch {}

  // Load accepted customers for the manual picker
  const dbCustomers = await db.customers.findMany({
    where: { applicationStatus: "ACCEPTED" },
    select: { id: true, firstName: true, lastName: true, email: true, businessName: true },
    orderBy: { applicationDate: "desc" },
    take: 200,
  });

  return json({
    segment,
    linkedCatalog,
    uniqueTags,
    shopifySegments,
    dbCustomers,
    condition: parseCondition(segment.customercondition),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const segmentId = params.id;
  if (!segmentId) throw new Error("Program ID is required");

  const formData = await request.formData();
  const intent   = formData.get("intent")?.toString();

  if (intent === "delete") {
    await db.segment.delete({ where: { id: segmentId } });
    return redirect("/app/segments");
  }

  const condType  = formData.get("condType")?.toString()  || "tag";
  const condValue = formData.get("condValue")?.toString()  || "";
  const status    = formData.get("status")?.toString()     || "Active";
  const title     = formData.get("title")?.toString();

  const customercondition = condValue ? `${condType}:${condValue.replace(/^@/, "")}` : "";
  const data: any = { customercondition, status };
  if (title) data.title = title;

  await db.segment.update({ where: { id: segmentId }, data });
  return json({ success: true });
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function ProgramPage() {
  const { segment, linkedCatalog, uniqueTags, shopifySegments, dbCustomers, condition } =
    useLoaderData<typeof loader>();

  const fetcher = useFetcher<{ success?: boolean }>();

  const [condType, setCondType]     = useState<CondType>(condition.type);
  const [tagValue, setTagValue]     = useState(condition.type === "tag"             ? condition.value : (uniqueTags[0] || ""));
  const [domainValue, setDomainValue] = useState(condition.type === "domain"        ? condition.value : "");
  const [ssValue, setSsValue]       = useState(condition.type === "shopify_segment" ? condition.value : (shopifySegments[0]?.id || ""));
  const [selectedCustomers, setSelectedCustomers] = useState<string[]>(condition.customerIds);
  const [customerSearch, setCustomerSearch] = useState("");
  const [status, setStatus]         = useState(segment.status || "Active");
  const [title, setTitle]           = useState(segment.title  || "");
  const [unsaved, setUnsaved]       = useState(false);

  const mark = () => setUnsaved(true);

  const toggleCustomer = (id: string) => {
    setSelectedCustomers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    mark();
  };

  const getCondValue = () => {
    if (condType === "tag")             return tagValue;
    if (condType === "domain")          return domainValue.replace(/^@/, "");
    if (condType === "customers")       return selectedCustomers.join(",");
    if (condType === "shopify_segment") return ssValue;
    return "";
  };

  const save = () => {
    fetcher.submit(
      { intent: "save", condType, condValue: getCondValue(), status, title },
      { method: "post" }
    );
    setUnsaved(false);
  };

  const del = () => {
    if (confirm("Delete this buyer program? This cannot be undone.")) {
      fetcher.submit({ intent: "delete" }, { method: "post" });
    }
  };

  const tagOpts = [
    { label: "— Select a tag —", value: "" },
    ...uniqueTags.map((t) => ({ label: t, value: t })),
  ];
  const ssOpts = shopifySegments.map((s) => ({ label: s.name, value: s.id }));

  const filteredCustomers = dbCustomers.filter((c) => {
    const q = customerSearch.toLowerCase();
    if (!q) return true;
    return (
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.firstName ?? "").toLowerCase().includes(q) ||
      (c.lastName  ?? "").toLowerCase().includes(q) ||
      (c.businessName ?? "").toLowerCase().includes(q)
    );
  });

  const m = COND_META[condType];

  const btnBase: React.CSSProperties = {
    border: "none", cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
  };

  return (
    <Page
      backAction={{ content: "Buyer Programs", url: "/app/segments" }}
      title={title || segment.title}
      titleMetadata={<Badge tone={status === "Active" ? "success" : "attention"}>{status}</Badge>}
    >
      <BlockStack gap="500">
        {fetcher.data?.success && <Banner tone="success">Program saved.</Banner>}

        <InlineGrid columns={{ xs: 1, md: "3fr 1fr" }} gap="500">

          {/* ── Left ── */}
          <BlockStack gap="500">

            {/* Name */}
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <Text as="h2" variant="headingMd">Program name</Text>
              <div style={{ marginTop: 14 }}>
                <TextField
                  label="" labelHidden
                  value={title}
                  onChange={(v) => { setTitle(v); mark(); }}
                  placeholder="e.g. Trade Partners, VIP Accounts"
                  autoComplete="off"
                />
              </div>
            </div>

            {/* Condition */}
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>

              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px", background: "#fafafa", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>{m.icon}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>Enrollment condition</div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>Customers who match are automatically enrolled.</div>
                </div>
              </div>

              <div style={{ padding: "18px 22px" }}>
                <BlockStack gap="400">

                  {/* 4 type toggles */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {(["tag", "domain", "customers", "shopify_segment"] as CondType[]).map((type) => {
                      const tm = COND_META[type];
                      return (
                        <button
                          key={type}
                          onClick={() => { setCondType(type); mark(); }}
                          style={{
                            ...btnBase,
                            padding: "11px 10px", borderRadius: 9,
                            border: `1.5px solid ${condType === type ? tm.color : "#e2e8f0"}`,
                            background: condType === type ? tm.bg : "#fff",
                            color: condType === type ? tm.color : "#374151",
                            fontWeight: 600, fontSize: 12.5,
                            display: "flex", alignItems: "center", gap: 8,
                          }}
                        >
                          <span style={{ fontSize: 17 }}>{tm.icon}</span>
                          {tm.label}
                        </button>
                      );
                    })}
                  </div>

                  <Divider />

                  {/* Tag condition */}
                  {condType === "tag" && (
                    <Select
                      label="Customer tag"
                      options={tagOpts}
                      value={tagValue}
                      onChange={(v) => { setTagValue(v); mark(); }}
                      disabled={uniqueTags.length === 0}
                      helpText="Any customer in Shopify with this tag is enrolled."
                    />
                  )}

                  {/* Domain condition */}
                  {condType === "domain" && (
                    <TextField
                      label="Email domain"
                      value={domainValue}
                      onChange={(v) => { setDomainValue(v); mark(); }}
                      prefix="@"
                      placeholder="acme-corp.com"
                      autoComplete="off"
                      helpText="Any customer whose email ends with this domain is enrolled — no tagging needed."
                    />
                  )}

                  {/* Shopify segment condition */}
                  {condType === "shopify_segment" && (
                    ssOpts.length > 0 ? (
                      <Select
                        label="Shopify segment"
                        options={ssOpts}
                        value={ssValue}
                        onChange={(v) => { setSsValue(v); mark(); }}
                        helpText="All current members of this native Shopify segment are enrolled."
                      />
                    ) : (
                      <Banner tone="warning">
                        No Shopify segments found. Create them under Customers → Segments in your Shopify admin.
                      </Banner>
                    )
                  )}

                  {/* Manual customer picker */}
                  {condType === "customers" && (
                    <BlockStack gap="300">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          Pick customers ({selectedCustomers.length} selected)
                        </Text>
                        {selectedCustomers.length > 0 && (
                          <button
                            onClick={() => { setSelectedCustomers([]); mark(); }}
                            style={{ ...btnBase, background: "none", color: "#ef4444", fontSize: 12, fontWeight: 600 }}
                          >
                            Clear all
                          </button>
                        )}
                      </div>

                      {/* Search */}
                      <div style={{ position: "relative" }}>
                        <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", pointerEvents: "none" }}>⌕</span>
                        <input
                          type="text"
                          placeholder="Search by name, email or business…"
                          value={customerSearch}
                          onChange={(e) => setCustomerSearch(e.target.value)}
                          style={{
                            width: "100%", boxSizing: "border-box",
                            padding: "9px 12px 9px 32px",
                            border: "1px solid #e2e8f0", borderRadius: 8,
                            fontSize: 13, color: "#0f172a", fontFamily: "inherit", outline: "none",
                          }}
                        />
                      </div>

                      {/* Customer list */}
                      <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 10 }}>
                        {filteredCustomers.length === 0 && (
                          <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                            {dbCustomers.length === 0 ? "No accepted customers yet." : "No customers match your search."}
                          </div>
                        )}
                        {filteredCustomers.map((c, idx) => {
                          const isSelected = selectedCustomers.includes(c.id);
                          return (
                            <div
                              key={c.id}
                              onClick={() => toggleCustomer(c.id)}
                              style={{
                                display: "flex", alignItems: "center", gap: 12,
                                padding: "11px 14px",
                                borderBottom: idx < filteredCustomers.length - 1 ? "1px solid #f8fafc" : "none",
                                cursor: "pointer",
                                background: isSelected ? "#faf5ff" : "#fff",
                                transition: "background 0.1s",
                              }}
                            >
                              {/* Checkbox */}
                              <div style={{
                                width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                                border: `2px solid ${isSelected ? "#7c3aed" : "#d1d5db"}`,
                                background: isSelected ? "#7c3aed" : "#fff",
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}>
                                {isSelected && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}
                              </div>

                              {/* Avatar */}
                              <div style={{
                                width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                                background: isSelected ? "#ede9fe" : "#f1f5f9",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 13, fontWeight: 700, color: isSelected ? "#7c3aed" : "#64748b",
                              }}>
                                {((c.firstName?.[0] ?? "") + (c.lastName?.[0] ?? "")).toUpperCase() || "?"}
                              </div>

                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || c.businessName || "—"}
                                </div>
                                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{c.email}</div>
                              </div>

                              {c.businessName && (
                                <span style={{ fontSize: 11, color: "#64748b", background: "#f1f5f9", padding: "2px 8px", borderRadius: 10, flexShrink: 0 }}>
                                  {c.businessName}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {selectedCustomers.length > 0 && (
                        <div style={{ fontSize: 12, color: "#7c3aed", fontWeight: 500 }}>
                          {selectedCustomers.length} customer{selectedCustomers.length !== 1 ? "s" : ""} will be enrolled in this program.
                        </div>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </div>
            </div>

            {/* Linked catalog */}
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981" }} />
                <Text as="h2" variant="headingMd">Linked catalog</Text>
              </div>
              <Divider />
              <div style={{ marginTop: 14 }}>
                {linkedCatalog ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Badge tone={linkedCatalog.status === "active" ? "success" : "attention"}>
                        {linkedCatalog.status}
                      </Badge>
                      <Text as="span" fontWeight="bold">{linkedCatalog.title}</Text>
                    </div>
                    <Button variant="plain" url={`/app/catalogs/${linkedCatalog.id}`}>Open catalog →</Button>
                  </div>
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">No catalog linked yet.</Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Open a catalog and assign this program in its audience settings.
                    </Text>
                    <Button variant="plain" url="/app/catalogs">Go to catalogs</Button>
                  </BlockStack>
                )}
              </div>
            </div>

          </BlockStack>

          {/* ── Right ── */}
          <BlockStack gap="500">

            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <div style={{ padding: "16px 20px", background: "#fafafa", borderBottom: "1px solid #f1f5f9" }}>
                <Text as="h2" variant="headingMd">Settings</Text>
              </div>
              <div style={{ padding: "18px 20px" }}>
                <Select
                  label="Status"
                  options={[
                    { label: "Active", value: "Active" },
                    { label: "Draft",  value: "Draft" },
                  ]}
                  value={status}
                  onChange={(v) => { setStatus(v); mark(); }}
                  helpText={status === "Draft" ? "Program is paused — no auto-enrollment." : undefined}
                />
              </div>
            </div>

            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", padding: "16px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
              <BlockStack gap="300">
                <button
                  onClick={save}
                  disabled={!unsaved || fetcher.state === "submitting"}
                  style={{
                    ...btnBase,
                    width: "100%", padding: "12px",
                    borderRadius: 10, fontSize: 14, fontWeight: 650,
                    background: unsaved ? "#0f172a" : "#f1f5f9",
                    color: unsaved ? "#fff" : "#94a3b8",
                    boxShadow: unsaved ? "0 4px 14px rgba(15,23,42,0.18)" : "none",
                  }}
                >
                  {fetcher.state === "submitting" ? "Saving…" : "Save program"}
                </button>
                {unsaved && (
                  <button
                    onClick={() => {
                      setCondType(condition.type); setStatus(segment.status || "Active");
                      setTitle(segment.title || ""); setUnsaved(false);
                    }}
                    style={{ ...btnBase, width: "100%", padding: "9px", borderRadius: 10, fontSize: 13, background: "none", color: "#64748b", fontWeight: 500 }}
                  >
                    Discard changes
                  </button>
                )}
                <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
                  <button
                    onClick={del}
                    style={{ ...btnBase, width: "100%", padding: "9px", borderRadius: 10, fontSize: 13, background: "none", color: "#ef4444", fontWeight: 600 }}
                  >
                    Delete program
                  </button>
                </div>
              </BlockStack>
            </div>

          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
