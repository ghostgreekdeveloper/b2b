/**
 * Customer-facing wholesale application form — served through Shopify App Proxy.
 *
 * GET  /proxy/form  → renders the styled HTML form
 * POST /proxy/form  → processes the submission, returns HTML result
 *
 * Merchants embed this form on any Shopify page with:
 *   <iframe src="/a/b2b-wholesale/form" style="width:100%;border:none;min-height:600px;"></iframe>
 *
 * Security:
 *  - authenticate.public.appProxy() validates HMAC on every request.
 *  - logged_in_customer_id is injected by Shopify; cannot be forged.
 *  - All DB writes are scoped to the verified shop domain.
 */

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendEmail, newApplicationHtml, pendingHtml } from "../email.server";

const NUMERIC_RE = /^\d{1,20}$/;

// 60-second in-process cache — avoids a DB hit on every iframe load
const formCache = new Map<string, { form: any; exp: number }>();
async function getCachedForm(shop: string) {
  const hit = formCache.get(shop);
  if (hit && hit.exp > Date.now()) return hit.form;
  const form = await db.form.findFirst({ where: { shopDomain: shop } });
  formCache.set(shop, { form, exp: Date.now() + 60_000 });
  return form;
}

// ─── Loader (GET) ────────────────────────────────────────────────────────────

export const loader = async ({ request }: any) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";

  const form = await getCachedForm(shop);

  // Referrer guard: once a page is published (shopifyPageId is set), only serve
  // the form when the request originates from that specific Shopify page.
  // Blocks merchants from copying the iframe to other pages/themes.
  // Fails open when Referer is absent (direct access, privacy settings, testing).
  if (form?.shopifyPageId && form?.urlHandle) {
    const referer = request.headers.get("referer") ?? "";
    if (referer && !referer.includes(`/pages/${form.urlHandle as string}`)) {
      return htmlResponse(shop, form, errorPage("This form is only available on its dedicated wholesale registration page."));
    }
  }

  if (!form || !(form.status as boolean)) {
    return htmlResponse(shop, form, errorPage("The wholesale application form is currently closed."));
  }

  if (!customerId || !NUMERIC_RE.test(customerId)) {
    const loginUrl = `https://${shop}/account/login?return_url=${encodeURIComponent("/a/b2b-wholesale/form")}`;
    return htmlResponse(shop, form, loginPage(loginUrl, form?.loginTitle as string | undefined, form?.loginMessage as string | undefined));
  }

  // Check if already applied
  const existing = await db.customers.findFirst({
    where: { id: customerId, shopDomain: shop },
    select: { applicationStatus: true },
  });

  if (existing) {
    const s = existing.applicationStatus as string;
    const titles: Record<string, string> = {
      PENDING:  (form?.pendingTitle  as string) || "Application Under Review",
      ACCEPTED: (form?.acceptedTitle as string) || "Wholesale Account Active",
      REJECTED: (form?.rejectedTitle as string) || "Application Not Approved",
    };
    const messages: Record<string, string> = {
      PENDING:  (form?.pendingMessage  as string) || "We've received your application and will review it shortly.",
      ACCEPTED: (form?.acceptedMessage as string) || "Your wholesale account is approved and active.",
      REJECTED: (form?.rejectedMessage as string) || "Unfortunately your application wasn't approved at this time.",
    };
    return htmlResponse(shop, form, statusPage(s, titles[s] ?? "Application Status", messages[s] ?? "Thank you for applying."));
  }

  const fields = safeParseFields(form.formFields as string);
  return htmlResponse(shop, form, renderForm(fields, form, shop, customerId));
};

// ─── Action (POST) ───────────────────────────────────────────────────────────

export const action = async ({ request }: any) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const customerId = url.searchParams.get("logged_in_customer_id") ?? "";

  const form = await db.form.findFirst({ where: { shopDomain: shop } });
  if (!form) return htmlResponse(shop, null, errorPage("Form not found."));

  if (!customerId || !NUMERIC_RE.test(customerId)) {
    return htmlResponse(shop, form, errorPage("You must be logged in to submit this form."));
  }

  const formData = await request.formData();

  // Use saveAs mappings from form field config — flatten FormRow[] or legacy FormField[]
  const fields = flattenFields(form.formFields as string);

  const standard: Record<string, string> = {};
  const addrData: Record<string, string> = {};
  const customResponses: Record<string, string> = {};

  const STANDARD_KEYS = ["firstName", "lastName", "email", "phone", "businessName", "taxId"];
  const ADDR_KEYS = ["address1", "address2", "city", "province", "zip", "country"];

  for (const field of fields) {
    const raw = (formData.get(`field_${field.id}`) as string | null)?.trim() ?? "";
    if (!raw) continue;
    const sa = field.saveAs as string;
    if (STANDARD_KEYS.includes(sa)) {
      standard[sa] = raw;
    } else if (ADDR_KEYS.includes(sa)) {
      addrData[sa] = raw;
    } else {
      customResponses[field.internalName || field.label || field.id] = raw;
    }
  }

  // Create address record if any address data provided
  let addrId: number | undefined;
  if (Object.keys(addrData).length > 0) {
    const addr = await (db as any).address.create({
      data: {
        street: addrData.address1 || null,
        address2: addrData.address2 || null,
        city: addrData.city || "",
        province: addrData.province || null,
        zip: addrData.zip || "",
        country: addrData.country || "",
      },
    });
    addrId = addr.id;
  }

  const autoApprove = (form.approvalMode as string) === "AUTO";
  const status = autoApprove ? "ACCEPTED" : "PENDING";

  try {
    // Check if customer already applied
    const existing = await db.customers.findFirst({ where: { id: customerId, shopDomain: shop } });
    if (existing) {
      const s = existing.applicationStatus as string;
      const titles: Record<string, string> = {
        PENDING:  (form?.pendingTitle  as string) || "Application Under Review",
        ACCEPTED: (form?.acceptedTitle as string) || "Wholesale Account Active",
        REJECTED: (form?.rejectedTitle as string) || "Application Not Approved",
      };
      const msgs: Record<string, string> = {
        PENDING:  (form?.pendingMessage  as string) || "We've received your application and will review it shortly.",
        ACCEPTED: (form?.acceptedMessage as string) || "Your wholesale account is approved and active.",
        REJECTED: (form?.rejectedMessage as string) || "Unfortunately your application wasn't approved at this time.",
      };
      return htmlResponse(shop, form, statusPage(s, titles[s] ?? "Application Status", msgs[s] ?? "You have already submitted an application."));
    }

    await db.customers.create({
      data: {
        id: customerId,
        shopDomain: shop,
        firstName: standard.firstName || null,
        lastName:  standard.lastName  || null,
        email:     standard.email     || null,
        phone:     standard.phone     || null,
        businessName: standard.businessName || null,
        taxId:        standard.taxId        || null,
        applicationDate: new Date(),
        applicationStatus: status as any,
        shippingAddressId: addrId ?? null,
        formResponses: JSON.stringify(customResponses),
      } as any,
    });

    const apiKey     = form.resendApiKey      as string | null;
    const fromName   = (form.emailFromName    as string) || "B2B Wholesale";
    const accent     = (form.emailAccentColor as string) || "#303030";
    const custName   = `${standard.firstName || ""} ${standard.lastName || ""}`.trim() || "Unknown";

    const emailVars = {
      customerName:  custName,
      customerEmail: standard.email || "",
      businessName:  standard.businessName || "",
      shopName:      shop,
      shopUrl:       `https://${shop}`,
      adminUrl:      `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps/${process.env.SHOPIFY_API_KEY ?? ""}/app/customer/${customerId}`,
    };

    const fromAddr = (form.emailFromAddress as string) || "";
    const from     = fromAddr ? `${fromName} <${fromAddr}>` : undefined;

    // Notify admin of new application (fire-and-forget)
    if (form.adminNotificationEmail && apiKey) {
      const adminSubject = (form.emailAdminSubject as string) || `New wholesale application — ${standard.businessName || standard.firstName || "Unknown"}`;
      const adminHtml    = newApplicationHtml({ customerName: custName, customerEmail: standard.email || "", businessName: standard.businessName || "", shopName: shop, adminUrl: emailVars.adminUrl, fromName, accentColor: accent });
      sendEmail({ apiKey, to: form.adminNotificationEmail as string, subject: adminSubject, shopDomain: shop, html: adminHtml, from }).catch((err) => console.error("[B2B] admin notification email failed:", err));
    }

    // Send "application received" email to customer if enabled (fire-and-forget)
    console.log("[B2B] pending email check:", { hasApiKey: !!apiKey, email: standard.email || "(none)", enabled: form.emailPendingEnabled });
    if (apiKey && standard.email && form.emailPendingEnabled) {
      const pendingSubject = (form.emailPendingSubject as string) || "We received your application";
      const pendingHtmlOut = pendingHtml({ customerName: custName, shopName: shop, message: (form.emailPendingBody as string) || "Thank you for applying! Our team will review your application and get back to you shortly.", fromName, accentColor: accent });
      sendEmail({ apiKey, to: standard.email, subject: pendingSubject, shopDomain: shop, html: pendingHtmlOut, from }).catch((err) => console.error("[B2B] pending email failed:", err));
    }

    if (autoApprove) {
      const autoTag = (form.autoTag as string) ?? "";
      const autoExemptTax = (form.autoExemptTax as boolean) ?? false;
      // Fire-and-forget: tag + exempt in background using offline session token
      processAutoApproval(shop, customerId, autoTag, autoExemptTax).catch(() => {});
    }

    const message = (form.submissionMessage as string) || "Your application has been submitted!";
    return htmlResponse(shop, form, successPage(message, autoApprove));
  } catch (err) {
    console.error("[proxy.form] submission error:", err);
    return htmlResponse(shop, form, errorPage("Something went wrong. Please try again."));
  }
};

// ─── Auto-approval background work ───────────────────────────────────────────

async function processAutoApproval(
  shop: string,
  customerId: string,
  autoTag: string,
  autoExemptTax: boolean
) {
  const session = await (db as any).session.findFirst({
    where: { shop, isOnline: false },
    select: { accessToken: true },
  });
  if (!session?.accessToken) return;

  const token = session.accessToken as string;
  const customerGid = `gid://shopify/Customer/${customerId}`;

  const mutations: Promise<void>[] = [];

  if (autoTag && autoTag.trim()) {
    mutations.push(addTagToCustomer(shop, token, customerGid, autoTag.trim()));
  }
  if (autoExemptTax) {
    mutations.push(setTaxExempt(shop, token, customerGid));
  }

  await Promise.allSettled(mutations);
}

async function shopifyGraphql(shop: string, token: string, query: string, variables: any) {
  const res = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function addTagToCustomer(shop: string, token: string, customerGid: string, tag: string) {
  // Read current tags first
  const data = await shopifyGraphql(shop, token, `{ customer(id: "${customerGid}") { tags } }`, {});
  const existing: string[] = data?.data?.customer?.tags ?? [];
  if (existing.includes(tag)) return;
  const tags = [...existing, tag];
  await shopifyGraphql(shop, token, `
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) { userErrors { message } }
    }
  `, { input: { id: customerGid, tags } });
}

async function setTaxExempt(shop: string, token: string, customerGid: string) {
  await shopifyGraphql(shop, token, `
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) { userErrors { message } }
    }
  `, { input: { id: customerGid, taxExempt: true } });
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function htmlResponse(shop: string, form: any, body: string) {
  const bg    = (form?.backgroundColor as string) ?? "#FFFFFF";
  const w     = (form?.formWidth as number) ?? 600;
  const fs    = (form?.fontSize as number) ?? 14;
  const fw    = (form?.fontWeight as string) ?? "400";
  const hc    = (form?.headingColor as string) ?? "#303030";
  const lc    = (form?.labelColor as string) ?? "#303030";
  const ic    = (form?.inputFieldColor as string) ?? "#303030";
  const pc    = (form?.primaryButtonColor as string) ?? "#303030";
  const sc    = (form?.secondaryButtonColor as string) ?? "#FFFFFF";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Wholesale Application</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  font-size:${fs}px;font-weight:${fw};color:${lc};
  padding:44px 20px 80px;line-height:1.6;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
.wrap{max-width:${w}px;margin:0 auto}
.form-card{
  background:${bg};border-radius:20px;overflow:hidden;
  box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 16px rgba(0,0,0,0.06),0 24px 34px rgba(0,0,0,0.07);
}
.form-card-body{padding:40px 44px 48px}
.form-eyebrow{
  display:inline-flex;align-items:center;gap:7px;
  background:${pc}15;color:${pc};
  border-radius:100px;padding:4px 13px 4px 9px;
  font-size:.7em;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;margin-bottom:16px;
}
.form-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:${pc};flex-shrink:0;display:inline-block}
h2{color:${hc};font-size:2em;font-weight:800;letter-spacing:-0.04em;line-height:1.1;margin-bottom:10px}
.form-sub{
  color:#6b7280;font-size:.9375em;line-height:1.55;
  margin-bottom:32px;padding-bottom:28px;border-bottom:1.5px solid ${pc}25;
}
.field{display:flex;flex-direction:column;gap:6px}
label{display:block;font-size:.8125em;font-weight:600;color:${lc};letter-spacing:.01em}
label .req{color:#ef4444;margin-left:2px}
.desc{font-size:.8em;color:#9ca3af;line-height:1.4;margin-top:-2px}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=file],select,textarea{
  width:100%;padding:11px 16px;
  border:1.5px solid #e5e7eb;border-radius:10px;
  font-size:${fs}px;font-family:inherit;
  color:${ic};background:#fafafa;outline:none;
  transition:border-color .18s,box-shadow .18s,background .18s;
  -webkit-appearance:none;
}
input:hover,select:hover,textarea:hover{border-color:#d1d5db}
input:focus,select:focus,textarea:focus{
  border-color:${pc};background:#fff;
  box-shadow:0 0 0 4px ${pc}15;
}
textarea{resize:vertical;min-height:96px}
.radio-group{display:flex;flex-direction:column;gap:10px;padding-top:3px}
.inline-opt{display:flex;align-items:flex-start;gap:10px;font-weight:400;cursor:pointer;line-height:1.55}
.inline-opt input{margin-top:3px;accent-color:${pc};flex-shrink:0;width:16px;height:16px}
.terms-text{font-size:.86em;line-height:1.7;color:#6b7280}
.form-footer{margin-top:28px;padding-top:24px;border-top:1px solid #f3f4f6}
.btn{
  display:flex;align-items:center;justify-content:center;gap:8px;
  padding:14px 28px;
  background:${pc};color:${sc};
  border:none;border-radius:12px;
  font-size:${fs}px;font-family:inherit;font-weight:700;
  cursor:pointer;width:100%;letter-spacing:.01em;
  transition:filter .15s,transform .12s,box-shadow .15s;
  -webkit-appearance:none;
  box-shadow:0 2px 8px ${pc}30;
}
.btn-arrow{display:inline-block;transition:transform .15s}
.btn:hover{filter:brightness(1.08);box-shadow:0 6px 24px ${pc}40;transform:translateY(-1px)}
.btn:hover .btn-arrow{transform:translateX(3px)}
.btn:active{transform:translateY(0);filter:brightness(.98)}
.status-wrap{text-align:center;padding:44px 32px 44px}
.status-icon{display:inline-block;margin-bottom:24px}
.status-title{font-size:1.5em;font-weight:800;color:#111827;letter-spacing:-0.03em;margin-bottom:12px;line-height:1.2}
.status-body{color:#6b7280;font-size:.9375em;line-height:1.65;max-width:340px;margin:0 auto;white-space:pre-line}
@media(max-width:540px){
  body{padding:20px 12px 60px}
  .form-card-body{padding:28px 24px 36px}
  h2{font-size:1.5em}
}
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
<script>
(function(){
  function send(){parent.postMessage({b2bH:document.documentElement.scrollHeight},'*');}
  send();
  new ResizeObserver(send).observe(document.body);
})();
<\/script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderForm(rowsOrFields: any[], form: any, _shop: string, _customerId: string) {
  const ctaLabel = (form?.ctaButtonText as string) || "Submit Application";
  const formTitle = (form?.formName as string) ?? "";

  // Handle both legacy FormField[] and new FormRow[] formats
  const rows: any[] = rowsOrFields.length > 0 && rowsOrFields[0]?.fields !== undefined
    ? rowsOrFields
    : rowsOrFields.map((f: any) => ({ id: f.id, fields: [f] }));

  const rowsHtml = rows.map((row: any) => {
    const cols = (row.fields as any[]).length || 1;
    const fieldsHtml = (row.fields as any[]).map((f: any) => renderField(f)).join("");
    return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:16px;margin-bottom:16px">${fieldsHtml}</div>`;
  }).join("\n");

  return `
<div class="form-card">
  <div class="form-card-accent"></div>
  <div class="form-card-body">
    ${formTitle ? `<h2>${escHtml(formTitle)}</h2>` : ""}
    <p class="form-sub">Fill in the details below to apply for a wholesale account.</p>
    <form method="POST">
${rowsHtml}
      <div class="form-footer">
        <button type="submit" class="btn">${escHtml(ctaLabel)}<span class="btn-arrow">→</span></button>
      </div>
    </form>
  </div>
</div>`;
}

function renderField(f: any): string {
  const req = f.required ? `<span class="req">*</span>` : "";
  const reqAttr = f.required ? " required" : "";
  const id = `field_${f.id}`;
  const labelHtml = !f.hideLabel ? `<label for="${id}">${escHtml(f.label)}${req}</label>` : "";
  const descHtml = f.description ? `<div class="desc">${escHtml(f.description)}</div>` : "";
  const t = f.type as string;

  let input = "";
  if (t === "text" || t === "email" || t === "tel" || t === "number") {
    input = `<input type="${t}" id="${id}" name="${id}" placeholder="${escHtml(f.placeholder || "")}"${reqAttr}>`;
  } else if (t === "textarea") {
    input = `<textarea id="${id}" name="${id}" placeholder="${escHtml(f.placeholder || "")}"${reqAttr}></textarea>`;
  } else if (t === "select") {
    const opts = (f.options as string[]).map((o) => `<option value="${escHtml(o)}">${escHtml(o)}</option>`).join("");
    input = `<select id="${id}" name="${id}"${reqAttr}><option value="">— select —</option>${opts}</select>`;
  } else if (t === "radio") {
    const opts = (f.options as string[]).map((o, i) =>
      `<label class="inline-opt"><input type="radio" name="${id}" value="${escHtml(o)}"${i === 0 && f.required ? " required" : ""}> ${escHtml(o)}</label>`
    ).join("");
    input = `<div class="radio-group">${opts}</div>`;
  } else if (t === "checkbox") {
    input = `<label class="inline-opt"><input type="checkbox" name="${id}" value="yes"${reqAttr}> ${escHtml(f.label)}</label>`;
  } else if (t === "terms") {
    input = `<label class="inline-opt terms-text"><input type="checkbox" name="${id}" value="yes" required> ${escHtml(f.content || f.label)}</label>`;
  } else if (t === "file") {
    input = `<input type="file" id="${id}" name="${id}"${reqAttr}>`;
  }

  return `<div class="field">${labelHtml}${input}${descHtml}</div>`;
}

// Keep old cases as aliases so existing saved forms with old type names still render
function _oldTypeAlias(t: string): string {
  if (t === "paragraph") return "textarea";
  if (t === "dropdown") return "select";
  if (t === "multiple_choice") return "radio";
  if (t === "terms") return "terms";
  if (t === "file_upload") return "file";
  return t;
}


const SVG_PENDING = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#fff7ed"/><circle cx="40" cy="40" r="26" stroke="#f97316" stroke-width="2.5" fill="none"/><line x1="40" y1="25" x2="40" y2="40" stroke="#f97316" stroke-width="2.5" stroke-linecap="round"/><line x1="40" y1="40" x2="49" y2="47" stroke="#f97316" stroke-width="2.5" stroke-linecap="round"/></svg>`;
const SVG_ACCEPTED = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#f0fdf4"/><circle cx="40" cy="40" r="26" stroke="#22c55e" stroke-width="2.5" fill="none"/><polyline points="28,41 36,49 53,31" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_REJECTED = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#fff1f2"/><circle cx="40" cy="40" r="26" stroke="#ef4444" stroke-width="2.5" fill="none"/><line x1="30" y1="30" x2="50" y2="50" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/><line x1="50" y1="30" x2="30" y2="50" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/></svg>`;
const SVG_SUCCESS = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#f0fdf4"/><circle cx="40" cy="40" r="26" stroke="#22c55e" stroke-width="2.5" fill="none"/><polyline points="28,41 36,49 53,31" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_INFO = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#eff6ff"/><circle cx="40" cy="40" r="26" stroke="#3b82f6" stroke-width="2.5" fill="none"/><line x1="40" y1="36" x2="40" y2="52" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round"/><circle cx="40" cy="29" r="2" fill="#3b82f6"/></svg>`;
const SVG_ERROR = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#fff1f2"/><circle cx="40" cy="40" r="26" stroke="#ef4444" stroke-width="2.5" fill="none"/><line x1="40" y1="29" x2="40" y2="45" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/><circle cx="40" cy="51" r="2" fill="#ef4444"/></svg>`;

function statusPage(status: string, title: string, message: string) {
  const icon = status === "ACCEPTED" ? SVG_ACCEPTED : status === "REJECTED" ? SVG_REJECTED : SVG_PENDING;
  return `<div class="form-card">
  <div class="status-wrap">
    <div class="status-icon">${icon}</div>
    <h3 class="status-title">${escHtml(title)}</h3>
    <p class="status-body">${escHtml(message)}</p>
  </div>
</div>`;
}

function successPage(message: string, autoApproved: boolean) {
  const body = autoApproved
    ? `${escHtml(message)}<br><br><span style="font-size:.875em;color:#6b7280">Your wholesale access has been activated automatically.</span>`
    : escHtml(message);
  return `<div class="form-card">
  <div class="status-wrap">
    <div class="status-icon">${SVG_SUCCESS}</div>
    <h3 class="status-title">Application Submitted!</h3>
    <p class="status-body">${body}</p>
  </div>
</div>`;
}

function errorPage(message: string) {
  return `<div class="form-card">
  <div class="status-wrap">
    <div class="status-icon">${SVG_ERROR}</div>
    <h3 class="status-title">Something went wrong</h3>
    <p class="status-body">${escHtml(message)}</p>
  </div>
</div>`;
}

function loginPage(loginUrl: string, title = "Login Required", message = "Please log in to your account to submit a wholesale application.") {
  const linkedMessage = message.replace(
    /(log in)/i,
    `<a href="${loginUrl}" style="color:#3b82f6;font-weight:700;text-decoration:underline">$1</a>`,
  );
  return `<div class="form-card">
  <div class="status-wrap">
    <div class="status-icon">${SVG_INFO}</div>
    <h3 class="status-title">${title}</h3>
    <p class="status-body">${linkedMessage}</p>
  </div>
</div>`;
}

function safeParseFields(raw: string): any[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Flattens FormRow[] or legacy FormField[] into a flat array of fields
function flattenFields(raw: string): any[] {
  const parsed = safeParseFields(raw);
  if (parsed.length === 0) return [];
  if (parsed[0]?.fields !== undefined) {
    return parsed.flatMap((row: any) => row.fields as any[]);
  }
  return parsed;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
