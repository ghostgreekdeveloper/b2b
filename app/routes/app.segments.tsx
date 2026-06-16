/**
 * Buyer Programs — replaces the old "Segments" concept.
 * A program is a rule that auto-enrolls matching customers into a catalog.
 *
 * Condition types stored in `customercondition`:
 *   tag:TAGNAME            → customer has a Shopify tag
 *   domain:company.com     → customer email ends with that domain
 *   customers:ID1,ID2,...  → specific customers by numeric Shopify ID
 *   shopify_segment:GID    → member of a native Shopify segment
 *   (legacy: bare string)  → treated as tag
 */
import React, { useState } from "react";
import { PlusIcon } from "@shopify/polaris-icons";
import {
  Page, Button, Modal, BlockStack, TextField, Text, Select, Divider,
} from "@shopify/polaris";
import { useLoaderData, useFetcher, Link } from "@remix-run/react";
import type { LoaderArgs, ActionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// ── Condition parsing ─────────────────────────────────────────────────────────
type CondType = "tag" | "domain" | "customers" | "shopify_segment";

function parseCondition(raw: string | null): { type: CondType; value: string } {
  const s = raw ?? "";
  if (s.startsWith("domain:"))          return { type: "domain",          value: s.slice(7) };
  if (s.startsWith("tag:"))             return { type: "tag",             value: s.slice(4) };
  if (s.startsWith("customers:"))       return { type: "customers",       value: s.slice(10) };
  if (s.startsWith("shopify_segment:")) return { type: "shopify_segment", value: s.slice(17) };
  return { type: "tag", value: s };
}

const COND_META: Record<CondType, { icon: string; color: string; bg: string; border: string; label: string }> = {
  tag:             { icon: "🏷", color: "#15803d", bg: "#f0fdf4", border: "#86efac", label: "Tag" },
  domain:          { icon: "✉",  color: "#1d4ed8", bg: "#eff6ff", border: "#93c5fd", label: "Email domain" },
  customers:       { icon: "👥", color: "#7c3aed", bg: "#faf5ff", border: "#d8b4fe", label: "Specific customers" },
  shopify_segment: { icon: "⬡",  color: "#c2410c", bg: "#fff7ed", border: "#fdba74", label: "Shopify segment" },
};

function condSummary(type: CondType, value: string): string {
  if (type === "tag")             return `Customers with tag "${value}"`;
  if (type === "domain")          return `Anyone with a @${value} email`;
  if (type === "customers")       return `${value.split(",").filter(Boolean).length} selected customer(s)`;
  if (type === "shopify_segment") return `Shopify segment members`;
  return value;
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderArgs) => {
  const { admin } = await authenticate.admin(request);

  const rawPrograms = await db.segment.findMany({
    select: { id: true, title: true, customercondition: true, status: true },
    orderBy: { createdAt: "desc" },
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
    const res  = await admin.graphql(`query { segments(first: 50) { nodes { id name } } }`);
    const d    = await res.json();
    shopifySegments = d?.data?.segments?.nodes ?? [];
  } catch {}

  const catalogs = await db.catalog.findMany({ select: { id: true, title: true, segmentId: true } });

  const programs = rawPrograms.map((p) => {
    const cond = parseCondition(p.customercondition);
    return {
      ...p,
      cond,
      catalog: catalogs.find((c) => c.segmentId === p.id) ?? null,
    };
  });

  return json({ programs, uniqueTags, shopifySegments });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionArgs) => {
  const formData = await request.formData();
  const title    = formData.get("title")?.toString()    || "New Program";
  const condType = formData.get("condType")?.toString()  || "tag";
  const condVal  = formData.get("condValue")?.toString() || "";

  if (!condVal) return json({ error: "Condition value is required." }, { status: 400 });

  const customercondition = `${condType}:${condVal.replace(/^@/, "")}`;
  const p = await db.segment.create({ data: { title, customercondition, status: "Active" } });
  return redirect(`/app/segment/${p.id}`);
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function BuyerProgramsPage() {
  const { programs, uniqueTags, shopifySegments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [open, setOpen]           = useState(false);
  const [newTitle, setNewTitle]   = useState("");
  const [condType, setCondType]   = useState<CondType>("tag");
  const [tagValue, setTagValue]   = useState(uniqueTags[0] || "");
  const [domainValue, setDomainValue] = useState("");
  const [shopifySegId, setShopifySegId] = useState(shopifySegments[0]?.id || "");

  const active   = programs.filter((p) => p.status === "Active").length;
  const withCat  = programs.filter((p) => p.catalog).length;

  const create = () => {
    let cv = "";
    if (condType === "tag")             cv = tagValue;
    if (condType === "domain")          cv = domainValue.replace(/^@/, "");
    if (condType === "shopify_segment") cv = shopifySegId;
    if (!cv) return;
    fetcher.submit({ title: newTitle || "New Program", condType, condValue: cv }, { method: "post" });
    setOpen(false);
  };

  const tagOpts = uniqueTags.map((t) => ({ label: t, value: t }));
  const ssOpts  = shopifySegments.map((s) => ({ label: s.name, value: s.id }));

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
                  <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Customer enrollment</span>
                </div>
                <h1 style={{ margin: 0, fontSize: 28, fontWeight: 750, color: "#f8fafc", letterSpacing: "-0.03em" }}>Buyer Programs</h1>
              </div>
              <Button variant="primary" icon={PlusIcon} onClick={() => setOpen(true)}>
                New program
              </Button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {[
                { label: "Total",        value: programs.length, icon: "⬡" },
                { label: "Active",       value: active,          icon: "◉" },
                { label: "With catalog", value: withCat,         icon: "◈" },
              ].map((s) => (
                <div key={s.label} style={{ background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>{s.icon} {s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 750, color: "#f1f5f9", letterSpacing: "-0.02em" }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Program cards — stacked rules, NOT a table */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {programs.length === 0 && (
            <div style={{
              padding: "64px 24px", borderRadius: 14, border: "2px dashed #e2e8f0",
              textAlign: "center", color: "#94a3b8",
            }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>⬡</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#475569", marginBottom: 4 }}>No programs yet</div>
              <div style={{ fontSize: 13 }}>Create a buyer program to auto-enroll matching customers into a price catalog.</div>
              <button
                onClick={() => setOpen(true)}
                style={{
                  marginTop: 20, padding: "10px 22px", borderRadius: 8,
                  background: "#0f172a", color: "#fff", border: "none",
                  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
              >
                + New program
              </button>
            </div>
          )}

          {programs.map((p) => {
            const m = COND_META[p.cond.type];
            return (
              <Link key={p.id} to={`/app/segment/${p.id}`} style={{ textDecoration: "none" }}>
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: 0,
                    background: "#fff", borderRadius: 12,
                    border: "1px solid #e5e7eb",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                    overflow: "hidden", cursor: "pointer",
                    transition: "box-shadow 0.15s, transform 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 16px rgba(0,0,0,0.1)";
                    (e.currentTarget as HTMLDivElement).style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
                    (e.currentTarget as HTMLDivElement).style.transform = "";
                  }}
                >
                  {/* Colored accent bar */}
                  <div style={{ width: 4, alignSelf: "stretch", background: m.color, flexShrink: 0 }} />

                  {/* Condition type icon */}
                  <div style={{
                    width: 56, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 22, flexShrink: 0, padding: "20px 0",
                    background: m.bg,
                  }}>
                    {m.icon}
                  </div>

                  {/* Main content */}
                  <div style={{ flex: 1, padding: "16px 20px", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{p.title}</span>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
                        padding: "2px 8px", borderRadius: 20,
                        background: m.bg, color: m.color, border: `1px solid ${m.border}`,
                      }}>
                        {m.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "#64748b" }}>
                      {condSummary(p.cond.type, p.cond.value)}
                    </div>
                  </div>

                  {/* Catalog + status */}
                  <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    {p.catalog ? (
                      <span style={{
                        padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                        background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe",
                      }}>
                        📂 {p.catalog.title}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: "#cbd5e1" }}>No catalog</span>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <div style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: p.status === "Active" ? "#22c55e" : "#94a3b8",
                        boxShadow: p.status === "Active" ? "0 0 5px #22c55e80" : "none",
                      }} />
                      <span style={{ fontSize: 12, color: "#64748b", fontWeight: 500 }}>{p.status}</span>
                    </div>

                    <span style={{ color: "#cbd5e1", fontSize: 18 }}>›</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </BlockStack>

      {/* Create modal */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New buyer program"
        primaryAction={{ content: "Create program", onAction: create, loading: fetcher.state === "submitting" }}
        secondaryActions={[{ content: "Cancel", onAction: () => setOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField
              label="Program name"
              value={newTitle}
              onChange={setNewTitle}
              placeholder="e.g. Trade Partners, VIP Accounts"
              autoComplete="off"
            />
            <Divider />
            <Text as="p" variant="bodyMd" fontWeight="semibold">Enrollment condition</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Customers who satisfy this condition are automatically enrolled in this program and receive its catalog pricing.
            </Text>

            {/* 4 condition type buttons */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {(["tag", "domain", "shopify_segment"] as CondType[]).map((type) => {
                const m = COND_META[type];
                return (
                  <button
                    key={type}
                    onClick={() => setCondType(type)}
                    style={{
                      padding: "12px 10px", borderRadius: 8, cursor: "pointer",
                      border: `1.5px solid ${condType === type ? m.color : "#e2e8f0"}`,
                      background: condType === type ? m.bg : "#fff",
                      color: condType === type ? m.color : "#374151",
                      fontWeight: 600, fontSize: 12.5, fontFamily: "inherit",
                      display: "flex", alignItems: "center", gap: 7, justifyContent: "center",
                      transition: "all 0.15s",
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{m.icon}</span>
                    {m.label}
                  </button>
                );
              })}
            </div>

            {condType === "tag" && (
              <Select
                label="Customer tag"
                options={tagOpts.length ? tagOpts : [{ label: "No tags found", value: "" }]}
                value={tagValue}
                onChange={setTagValue}
                helpText="Customers with this Shopify tag are enrolled."
              />
            )}
            {condType === "domain" && (
              <TextField
                label="Email domain"
                value={domainValue}
                onChange={setDomainValue}
                prefix="@"
                placeholder="acme-corp.com"
                autoComplete="off"
                helpText="Any customer whose email ends with this domain is enrolled automatically."
              />
            )}
            {condType === "shopify_segment" && (
              ssOpts.length > 0 ? (
                <Select
                  label="Shopify segment"
                  options={ssOpts}
                  value={shopifySegId}
                  onChange={setShopifySegId}
                  helpText="Members of this native Shopify segment are enrolled."
                />
              ) : (
                <Text as="p" tone="subdued" variant="bodySm">
                  No Shopify segments found. Create segments in your Shopify admin under Customers → Segments.
                </Text>
              )
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
