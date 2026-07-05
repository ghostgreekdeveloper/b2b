import React, { useState, useCallback } from "react";
import { Link, useLoaderData, useFetcher } from "@remix-run/react";
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { Page, BlockStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { writeCustomerDiscountMetafield } from "../writeCustomerMetafield.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();

  if (fd.get("intent") === "add-customer") {
    const query = (fd.get("query") as string ?? "").trim();
    if (!query) return json({ error: "Email or customer ID is required." });

    const searchQ = query.includes("@") ? `email:${query}` : `id:${query}`;
    const res = await admin.graphql(
      `query FindC($q:String!){customers(first:1,query:$q){nodes{id firstName lastName email}}}`,
      { variables: { q: searchQ } },
    );
    const node = (await res.json())?.data?.customers?.nodes?.[0];
    if (!node) return json({ error: "No Shopify customer found. Check the email or ID and try again." });

    const customerId = (node.id as string).replace("gid://shopify/Customer/", "");
    const existing = await db.customers.findFirst({ where: { id: customerId } });

    if (existing) {
      await db.customers.update({ where: { id: customerId }, data: { applicationStatus: "ACCEPTED" } });
    } else {
      await db.customers.create({
        data: {
          id: customerId, shopDomain: shop,
          firstName: node.firstName || null,
          lastName: node.lastName || null,
          email: node.email || null,
          applicationDate: new Date(),
          applicationStatus: "ACCEPTED",
        } as any,
      });
    }

    // Auto-tag / tax exempt if form is configured
    const form = await db.form.findFirst({ where: { shopDomain: shop } });
    if (form?.autoTag || form?.autoExemptTax) {
      const sessionRow = await (db as any).session.findFirst({ where: { shop, isOnline: false }, select: { accessToken: true } });
      if (sessionRow?.accessToken) {
        const gid = `gid://shopify/Customer/${customerId}`;
        const token = sessionRow.accessToken as string;
        const mutations: Promise<any>[] = [];
        if (form.autoTag) {
          mutations.push(
            fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
              method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
              body: JSON.stringify({ query: `mutation{customerUpdate(input:{id:"${gid}",tags:["${form.autoTag}"]}){userErrors{message}}}` }),
            }).catch(() => {}),
          );
        }
        if (form.autoExemptTax) {
          mutations.push(
            fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
              method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
              body: JSON.stringify({ query: `mutation{customerUpdate(input:{id:"${gid}",taxExempt:true}){userErrors{message}}}` }),
            }).catch(() => {}),
          );
        }
        Promise.allSettled(mutations).catch(() => {});
      }
    }

    // Fetch tags and auto-assign catalogs — same logic as the approve intent
    try {
      const tagsRes = await admin.graphql(
        `query { customer(id: "gid://shopify/Customer/${customerId}") { tags } }`
      );
      const tags: string[] = (await tagsRes.json())?.data?.customer?.tags ?? [];
      if (tags.length) {
        const segments = await db.segment.findMany({
          where: { status: "Active" }, select: { id: true, customercondition: true },
        });
        const matchedSegments = segments.filter((s) => {
          const cond = s.customercondition ?? "";
          if (cond.startsWith("domain:") || cond.startsWith("customers:") || cond.startsWith("shopify_segment:")) return false;
          const tag = cond.startsWith("tag:") ? cond.slice(4) : cond;
          return tags.includes(tag);
        });
        const assignedIds: number[] = [];
        for (const seg of matchedSegments) {
          const cats = await db.catalog.findMany({
            where: { segmentId: seg.id, status: "active" }, select: { id: true },
          });
          cats.forEach((c: any) => { const id = Number(c.id); if (!assignedIds.includes(id)) assignedIds.push(id); });
        }
        if (assignedIds.length > 0) {
          await db.$executeRaw`DELETE FROM customer_catalogs WHERE "customerId" = ${customerId}`;
          for (const catId of assignedIds) {
            await db.$executeRaw`INSERT INTO customer_catalogs ("customerId", "catalogId") VALUES (${customerId}, ${catId}) ON CONFLICT DO NOTHING`;
          }
          await db.customers.updateMany({ where: { id: customerId, catalogId: null }, data: { catalogId: assignedIds[0] } });
          writeCustomerDiscountMetafield(admin, customerId, shop).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[B2B] add-customer auto-assign failed:", err);
    }

    return json({ added: { id: customerId, firstName: node.firstName, lastName: node.lastName, email: node.email } });
  }

  return json({ error: "Unknown intent." });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const customers = await db.customers.findMany({
    where: { shopDomain: shop, applicationStatus: "ACCEPTED" },
    select: {
      id: true, firstName: true, lastName: true, email: true,
      businessName: true, applicationDate: true, applicationStatus: true,
      minimumOrderCents: true,
      catalog: { select: { title: true } },
    },
    orderBy: { applicationDate: "desc" },
  });
  return json({ customers });
};

const STATUS = {
  ACCEPTED: { label: "Approved",  bg: "#f0fdf4", color: "#15803d", border: "#86efac", dot: "#22c55e" },
  REJECTED: { label: "Rejected",  bg: "#fef2f2", color: "#b91c1c", border: "#fca5a5", dot: "#ef4444" },
  PENDING:  { label: "Pending",   bg: "#fefce8", color: "#854d0e", border: "#fde047", dot: "#facc15" },
} as const;

const AVATAR_COLORS = [
  ["#ede9fe", "#6d28d9"], ["#dbeafe", "#1d4ed8"], ["#d1fae5", "#047857"],
  ["#fce7f3", "#be185d"], ["#ffedd5", "#c2410c"], ["#e0f2fe", "#0369a1"],
];

export default function CustomersPage() {
  const { customers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ added?: any; error?: string }>();

  const [tab, setTab]     = useState<"all" | "ACCEPTED">("all");
  const [search, setSearch] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [addQuery, setAddQuery] = useState("");

  const isAdding = fetcher.state === "submitting";
  const addResult = fetcher.state === "idle" ? fetcher.data : undefined;

  const submitAdd = useCallback(() => {
    fetcher.submit({ intent: "add-customer", query: addQuery }, { method: "post" });
  }, [fetcher, addQuery]);

  // Close modal on success
  React.useEffect(() => {
    if (addResult?.added) {
      setShowAddModal(false);
      setAddQuery("");
    }
  }, [addResult]);

  const counts = {
    all: customers.length,
    ACCEPTED: customers.length,
  };

  const filtered = customers.filter((c) => {
    const q = search.toLowerCase();
    return !q ||
      `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.businessName ?? "").toLowerCase().includes(q);
  });

  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";

  const avatarColor = (idx: number) => AVATAR_COLORS[idx % AVATAR_COLORS.length];

  const TAB_DEFS: Array<{ key: typeof tab; label: string }> = [
    { key: "all", label: "All Approved" },
  ];

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
          <div style={{ position: "absolute", bottom: -60, left: 100, width: 180, height: 180, borderRadius: "50%", background: "radial-gradient(circle, #10b98120 0%, transparent 70%)", pointerEvents: "none" }} />
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "3px 12px", marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Wholesale accounts</span>
              </div>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 750, color: "#f8fafc", letterSpacing: "-0.03em" }}>Customers</h1>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, maxWidth: 360 }}>
              {[
                { label: "Approved customers", value: counts.all, icon: "◉" },
                { label: "Showing",            value: filtered.length, icon: "◎" },
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
            {/* Tab buttons */}
            <div style={{ display: "flex", gap: 4, background: "#f1f5f9", borderRadius: 8, padding: 3 }}>
              {TAB_DEFS.map((t) => (
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
                  <span style={{
                    marginLeft: 6, fontSize: 11,
                    color: tab === t.key ? "#6366f1" : "#94a3b8", fontWeight: 700,
                  }}>
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
                placeholder="Search name, email or business…"
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
              {filtered.length} of {customers.length}
            </div>

            {/* Add customer button */}
            <button
              onClick={() => setShowAddModal(true)}
              style={{
                padding: "7px 16px", background: "#0f172a", border: "none",
                borderRadius: 8, color: "#f1f5f9", fontSize: 13, fontWeight: 600,
                cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
              }}
            >
              + Add customer
            </button>
          </div>

          {/* Column headers */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) minmax(0,1.2fr) 110px 90px",
            columnGap: 16, padding: "9px 20px",
            background: "#f9fafb", borderBottom: "1px solid #e5e7eb",
          }}>
            {["Customer", "Email / Business", "Catalog", "Applied", "Status"].map((h) => (
              <div key={h} style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          {filtered.length === 0 && (
            <div style={{ padding: "52px 24px", textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>◎</div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#475569", marginBottom: 4 }}>No customers found</div>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>Try adjusting your search or filter.</div>
            </div>
          )}

          {filtered.map((c, idx) => {
            const statusKey = (c.applicationStatus ?? "PENDING") as keyof typeof STATUS;
            const st = STATUS[statusKey] ?? STATUS.PENDING;
            const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
            const initials = (`${(c.firstName ?? "?")[0]}${(c.lastName ?? "")[0] ?? ""}`).toUpperCase();
            const [avatarBg, avatarColor] = AVATAR_COLORS[idx % AVATAR_COLORS.length];

            return (
              <Link
                key={c.id}
                to={`/app/customer/${c.id}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) minmax(0,1.2fr) 110px 90px",
                    columnGap: 16, padding: "13px 20px", alignItems: "center",
                    borderBottom: idx < filtered.length - 1 ? "1px solid #f8fafc" : "none",
                    cursor: "pointer", transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  {/* Customer name + avatar */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                      background: avatarBg, color: avatarColor,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 13, fontWeight: 750,
                    }}>
                      {initials}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontWeight: 650, fontSize: 13.5, color: "#0f172a",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {name}
                      </div>
                      {c.businessName && (
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {c.businessName}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Email */}
                  <div style={{ fontSize: 13, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {c.email ?? "—"}
                  </div>

                  {/* Catalog */}
                  <div>
                    {c.catalog ? (
                      <span style={{
                        display: "inline-block", maxWidth: "100%",
                        padding: "3px 10px", borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                        background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      }}>
                        {c.catalog.title}
                      </span>
                    ) : (
                      <span style={{ color: "#e2e8f0", fontSize: 14 }}>—</span>
                    )}
                  </div>

                  {/* Applied date */}
                  <div style={{ fontSize: 12.5, color: "#94a3b8" }}>
                    {fmtDate(c.applicationDate as string | null)}
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
                </div>
              </Link>
            );
          })}
        </div>
      </BlockStack>

      {/* ── Add customer manually modal ── */}
      {showAddModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 500,
          background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "center", justifyContent: "center",
        }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false); }}
        >
          <div style={{
            background: "#fff", borderRadius: 16, padding: "28px 28px 24px",
            width: "100%", maxWidth: 440, boxShadow: "0 24px 64px rgba(15,23,42,0.22)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 750, color: "#0f172a", letterSpacing: "-0.02em" }}>Add customer</div>
                <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 2 }}>Approve a customer directly by email or Shopify ID</div>
              </div>
              <button
                onClick={() => { setShowAddModal(false); setAddQuery(""); }}
                style={{ background: "#f1f5f9", border: "none", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 16, color: "#64748b", display: "flex", alignItems: "center", justifyContent: "center" }}
              >✕</button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Customer email or Shopify ID</label>
              <input
                type="text"
                placeholder="customer@example.com or 1234567890"
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !isAdding && addQuery && submitAdd()}
                autoFocus
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "10px 14px", border: "1px solid #e2e8f0", borderRadius: 8,
                  fontSize: 13.5, color: "#0f172a", fontFamily: "inherit", outline: "none",
                }}
              />
            </div>

            {addResult?.error && (
              <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 13, color: "#b91c1c", marginBottom: 14 }}>
                {addResult.error}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setShowAddModal(false); setAddQuery(""); }}
                style={{ padding: "8px 18px", background: "#f1f5f9", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#64748b" }}
              >
                Cancel
              </button>
              <button
                onClick={submitAdd}
                disabled={isAdding || !addQuery.trim()}
                style={{
                  padding: "8px 20px", background: isAdding ? "#6366f199" : "#6366f1",
                  border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  cursor: isAdding ? "default" : "pointer", color: "#fff",
                  opacity: !addQuery.trim() ? 0.5 : 1,
                }}
              >
                {isAdding ? "Looking up…" : "Add & approve"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
