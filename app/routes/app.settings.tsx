import { useState } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page, Card, BlockStack, InlineStack, TextField,
  Button, Text, Divider, Banner, Badge, Checkbox,
} from "@shopify/polaris";
import {
  DndContext, DragOverlay, PointerSensor,
  useSensor, useSensors, closestCenter,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { encrypt, decrypt } from "../crypto.server";
import { sendEmailGetResult, renderEmailBlocks, parseEmailBlocks } from "../email.server";
import type { EmailBlock, EmailBlockType } from "../email.server";

// ── Block helpers ─────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

function parseBlocks(raw: string | null | undefined): EmailBlock[] {
  try {
    const p = JSON.parse(raw ?? "[]");
    if (Array.isArray(p) && p.length > 0) return p as EmailBlock[];
  } catch {}
  return [];
}

const DEFAULT_BLOCKS: Record<string, EmailBlock[]> = {
  admin: [
    { id: "h",   type: "header",  text: "B2B Wholesale", bgColor: "#111827", textColor: "#ffffff" },
    { id: "ic",  type: "icon",    iconType: "info" },
    { id: "t1",  type: "text",    content: "New wholesale application", fontSize: 22, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t2",  type: "text",    content: "A new customer has applied on {{shopName}}.", fontSize: 14, color: "#6b7280", align: "center" },
    { id: "sp1", type: "spacer",  spacerHeight: 8 },
    { id: "t3",  type: "text",    content: "{{customerName}}", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t4",  type: "text",    content: "{{customerEmail}} · {{businessName}}", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "d1",  type: "divider", dividerColor: "#ebebeb", showPlus: true },
    { id: "t5",  type: "text",    content: "B2B Wholesale", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t6",  type: "text",    content: "Your team", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "sp2", type: "spacer",  spacerHeight: 8 },
    { id: "btn", type: "button",  buttonLabel: "Review Application", buttonUrl: "{{adminUrl}}", buttonBg: "#2563eb", buttonTextColor: "#ffffff", buttonAlign: "center" },
    { id: "f",   type: "footer",  content: "Automated notification from B2B Wholesale.", color: "#9ca3af", align: "center", termsText: "Terms & Conditions", termsUrl: "{{shopUrl}}/policies/terms-of-service", linkColor: "#9ca3af" },
  ],
  pending: [
    { id: "h",   type: "header",  text: "B2B Wholesale", bgColor: "#111827", textColor: "#ffffff" },
    { id: "ic",  type: "icon",    iconType: "pending" },
    { id: "t1",  type: "text",    content: "Application received!", fontSize: 22, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t2",  type: "text",    content: "Thank you for applying! Our team will review your application and get back to you shortly.", fontSize: 14, color: "#6b7280", align: "center" },
    { id: "sp1", type: "spacer",  spacerHeight: 8 },
    { id: "t3",  type: "text",    content: "{{customerName}}", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t4",  type: "text",    content: "Your wholesale account", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "d1",  type: "divider", dividerColor: "#ebebeb", showPlus: true },
    { id: "t5",  type: "text",    content: "B2B Wholesale", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t6",  type: "text",    content: "Your team", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "f",   type: "footer",  content: "Automated notification from B2B Wholesale.", color: "#9ca3af", align: "center", termsText: "Terms & Conditions", termsUrl: "{{shopUrl}}/policies/terms-of-service", linkColor: "#9ca3af" },
  ],
  approved: [
    { id: "h",   type: "header",  text: "B2B Wholesale", bgColor: "#111827", textColor: "#ffffff" },
    { id: "ic",  type: "icon",    iconType: "approved" },
    { id: "t1",  type: "text",    content: "You're approved!", fontSize: 22, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t2",  type: "text",    content: "Congratulations! Your wholesale account is now active and ready to use.", fontSize: 14, color: "#6b7280", align: "center" },
    { id: "sp1", type: "spacer",  spacerHeight: 8 },
    { id: "t3",  type: "text",    content: "{{customerName}}", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t4",  type: "text",    content: "Your wholesale account", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "d1",  type: "divider", dividerColor: "#ebebeb", showPlus: true },
    { id: "t5",  type: "text",    content: "B2B Wholesale", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t6",  type: "text",    content: "Your team", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "sp2", type: "spacer",  spacerHeight: 8 },
    { id: "btn", type: "button",  buttonLabel: "Start Shopping", buttonUrl: "{{shopUrl}}", buttonBg: "#2563eb", buttonTextColor: "#ffffff", buttonAlign: "center" },
    { id: "f",   type: "footer",  content: "Automated notification from B2B Wholesale.", color: "#9ca3af", align: "center", termsText: "Terms & Conditions", termsUrl: "{{shopUrl}}/policies/terms-of-service", linkColor: "#9ca3af" },
  ],
  rejected: [
    { id: "h",   type: "header",  text: "B2B Wholesale", bgColor: "#111827", textColor: "#ffffff" },
    { id: "ic",  type: "icon",    iconType: "rejected" },
    { id: "t1",  type: "text",    content: "Update on your application", fontSize: 22, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t2",  type: "text",    content: "Thank you for your interest. Unfortunately we're unable to approve your application at this time.", fontSize: 14, color: "#6b7280", align: "center" },
    { id: "sp1", type: "spacer",  spacerHeight: 8 },
    { id: "t3",  type: "text",    content: "{{customerName}}", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t4",  type: "text",    content: "Your wholesale account", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "d1",  type: "divider", dividerColor: "#ebebeb", showPlus: true },
    { id: "t5",  type: "text",    content: "B2B Wholesale", fontSize: 15, fontWeight: "bold", color: "#111827", align: "center" },
    { id: "t6",  type: "text",    content: "Your team", fontSize: 13, color: "#9ca3af", align: "center" },
    { id: "f",   type: "footer",  content: "Automated notification from B2B Wholesale.", color: "#9ca3af", align: "center", termsText: "Terms & Conditions", termsUrl: "{{shopUrl}}/policies/terms-of-service", linkColor: "#9ca3af" },
  ],
};

function getBlocks(tab: string, raw: string): EmailBlock[] {
  const parsed = parseBlocks(raw);
  if (parsed.length > 0) return parsed;
  return (DEFAULT_BLOCKS[tab] ?? []).map(b => ({ ...b, id: uid() }));
}

function makeBlock(type: EmailBlockType): EmailBlock {
  const id = uid();
  switch (type) {
    case "header":  return { id, type, text: "B2B Wholesale", bgColor: "#111827", textColor: "#ffffff" };
    case "text":    return { id, type, content: "Your text here", fontSize: 15, color: "#374151", align: "left" };
    case "image":   return { id, type, imageUrl: "", imageAlt: "", imageWidth: 100, imageAlign: "center" };
    case "button":  return { id, type, buttonLabel: "Click here →", buttonUrl: "{{shopUrl}}", buttonBg: "#303030", buttonTextColor: "#ffffff", buttonAlign: "center" };
    case "divider": return { id, type, dividerColor: "#e5e7eb", showPlus: true };
    case "spacer":  return { id, type, spacerHeight: 24 };
    case "footer":  return { id, type, content: "Automated notification from B2B Wholesale.", color: "#9ca3af", align: "center", termsText: "Terms & Conditions", termsUrl: "{{shopUrl}}/policies/terms-of-service", linkColor: "#9ca3af" };
    case "terms":   return { id, type, content: "By submitting you agree to our terms and conditions." };
    case "icon":    return { id, type, iconType: "info" };
  }
}

const BLOCK_PALETTE: { type: EmailBlockType; label: string; icon: string; bg: string; fg: string }[] = [
  { type: "header",  label: "Header",  icon: "▣", bg: "#dbeafe", fg: "#1d4ed8" },
  { type: "text",    label: "Text",    icon: "T", bg: "#f0fdf4", fg: "#16a34a" },
  { type: "icon",    label: "Icon",    icon: "◎", bg: "#eff6ff", fg: "#2563eb" },
  { type: "image",   label: "Image",   icon: "◫", bg: "#fdf4ff", fg: "#9333ea" },
  { type: "button",  label: "Button",  icon: "◻", bg: "#fff7ed", fg: "#ea580c" },
  { type: "divider", label: "Divider", icon: "—", bg: "#f8fafc", fg: "#64748b" },
  { type: "spacer",  label: "Spacer",  icon: "↕", bg: "#f8fafc", fg: "#94a3b8" },
  { type: "footer",  label: "Footer",  icon: "ⓘ", bg: "#f0fdf4", fg: "#15803d" },
  { type: "terms",   label: "Terms",   icon: "§", bg: "#fef3c7", fg: "#b45309" },
];

const BLOCK_CHIP_COLORS: Record<string, { bg: string; fg: string }> = {
  header:  { bg: "#dbeafe", fg: "#1d4ed8" },
  text:    { bg: "#dcfce7", fg: "#15803d" },
  icon:    { bg: "#eff6ff", fg: "#2563eb" },
  image:   { bg: "#f3e8ff", fg: "#9333ea" },
  button:  { bg: "#ffedd5", fg: "#ea580c" },
  divider: { bg: "#f1f5f9", fg: "#64748b" },
  spacer:  { bg: "#f1f5f9", fg: "#94a3b8" },
  footer:  { bg: "#dcfce7", fg: "#15803d" },
  terms:   { bg: "#fef9c3", fg: "#b45309" },
};

function blockPreviewLabel(b: EmailBlock): string {
  switch (b.type) {
    case "header":  return b.text || "Header";
    case "text":    return (b.content ?? "").slice(0, 40) || "Text";
    case "image":   return b.imageUrl ? b.imageUrl.slice(0, 35) : "Image (no URL set)";
    case "button":  return b.buttonLabel || "Button";
    case "divider": return b.showPlus !== false ? "Divider with +" : "Divider line";
    case "spacer":  return `Spacer ${b.spacerHeight ?? 24}px`;
    case "icon":    return `Icon · ${b.iconType ?? "info"}`;
    case "footer":  return (b.content ?? "").slice(0, 40) || "Footer";
    case "terms":   return (b.content ?? "").slice(0, 40) || "Terms";
    default:        return b.type;
  }
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: any) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await db.form.findFirst({ where: { shopDomain: shop } });

  const rawKey       = (form?.resendApiKey as string) ?? "";
  const decryptedKey = rawKey ? decrypt(rawKey) : "";

  return json({
    apiKey:              decryptedKey,
    adminEmail:          (form?.adminNotificationEmail as string) ?? "",
    fromAddress:         (form?.emailFromAddress      as string) ?? "",
    fromName:            (form?.emailFromName         as string) ?? "B2B Wholesale",
    keyConfigured:       !!decryptedKey,
    emailPendingEnabled: (form?.emailPendingEnabled   as boolean) ?? false,
    emailAdminSubject:     (form?.emailAdminSubject     as string)  ?? "New wholesale application",
    emailPendingSubject:   (form?.emailPendingSubject   as string)  ?? "We received your application",
    emailApprovedSubject:  (form?.emailApprovedSubject  as string)  ?? "Your wholesale application has been approved",
    emailRejectedSubject:  (form?.emailRejectedSubject  as string)  ?? "Update on your wholesale application",
    emailAdminBlocks:    (form?.emailAdminBlocks    as string) ?? "[]",
    emailPendingBlocks:  (form?.emailPendingBlocks  as string) ?? "[]",
    emailApprovedBlocks: (form?.emailApprovedBlocks as string) ?? "[]",
    emailRejectedBlocks: (form?.emailRejectedBlocks as string) ?? "[]",
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: any) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent")?.toString();

  type ActionResult = { success: boolean; cleared: boolean; savedTemplates: boolean; testSent: boolean; testTemplate: string | null; testError: string | null };
  const ok  = (extra?: Partial<ActionResult>): Response => json<ActionResult>({ success: true,  cleared: false, savedTemplates: false, testSent: false, testTemplate: null, testError: null, ...extra });
  const err = (msg: string):                   Response => json<ActionResult>({ success: false, cleared: false, savedTemplates: false, testSent: false, testTemplate: null, testError: msg });

  if (intent === "clear-key") {
    await db.form.upsert({
      where:  { shopDomain: shop },
      update: { resendApiKey: null },
      create: { shopDomain: shop, status: true, resendApiKey: null },
    });
    return ok({ cleared: true });
  }

  if (intent === "save-templates") {
    const data = {
      emailAdminSubject:    fd.get("emailAdminSubject")?.toString()    ?? "",
      emailPendingEnabled:  fd.get("emailPendingEnabled") === "true",
      emailPendingSubject:  fd.get("emailPendingSubject")?.toString()  ?? "",
      emailApprovedSubject: fd.get("emailApprovedSubject")?.toString() ?? "",
      emailRejectedSubject: fd.get("emailRejectedSubject")?.toString() ?? "",
      emailAdminBlocks:     fd.get("emailAdminBlocks")?.toString()     ?? "[]",
      emailPendingBlocks:   fd.get("emailPendingBlocks")?.toString()   ?? "[]",
      emailApprovedBlocks:  fd.get("emailApprovedBlocks")?.toString()  ?? "[]",
      emailRejectedBlocks:  fd.get("emailRejectedBlocks")?.toString()  ?? "[]",
    };
    await db.form.upsert({
      where:  { shopDomain: shop },
      update: data,
      create: { shopDomain: shop, status: true, ...data },
    });
    return ok({ savedTemplates: true });
  }

  if (intent === "test-email") {
    const template  = fd.get("template")?.toString()  ?? "admin";
    const subject   = fd.get("subject")?.toString()   ?? "Test email";
    const rawBlocks = fd.get("blocks")?.toString()    ?? "[]";
    const form = await db.form.findFirst({ where: { shopDomain: shop } });
    const apiKey    = form?.resendApiKey ? decrypt(form.resendApiKey as string) : "";
    const toEmail   = (form?.adminNotificationEmail as string) ?? "";
    if (!apiKey)  return err("No API key configured — save settings first.");
    if (!toEmail) return err("No admin notification email set — save settings first.");
    const fromAddr  = (form?.emailFromAddress as string) ?? "";
    const fromNameV = (form?.emailFromName    as string) ?? "B2B Wholesale";
    const from      = fromAddr ? `${fromNameV} <${fromAddr}>` : undefined;
    const sampleVars: Record<string, string> = {
      customerName:  "Jane Smith",
      customerEmail: "jane@smithco.com",
      businessName:  "Smith Co.",
      shopName:      shop,
      shopUrl:       `https://${shop}`,
      adminUrl:      `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}`,
    };
    const blocks = parseEmailBlocks(rawBlocks);
    const html   = renderEmailBlocks(blocks, sampleVars);
    const result = await sendEmailGetResult({ apiKey, to: toEmail, subject: `[TEST] ${subject}`, html, from });
    if (!result.ok) return err(result.error ?? "Failed to send test email.");
    return ok({ testSent: true, testTemplate: template });
  }

  // intent === "save" (API key + admin email + from address)
  const apiKey      = fd.get("apiKey")?.toString()      ?? "";
  const adminEmail  = fd.get("adminEmail")?.toString()  ?? "";
  const fromAddress = fd.get("fromAddress")?.toString() ?? "";
  const fromNameVal = fd.get("fromName")?.toString()    ?? "B2B Wholesale";
  const encryptedKey = apiKey ? encrypt(apiKey) : null;
  await db.form.upsert({
    where:  { shopDomain: shop },
    update: { resendApiKey: encryptedKey, adminNotificationEmail: adminEmail, emailFromAddress: fromAddress, emailFromName: fromNameVal },
    create: { shopDomain: shop, status: true, resendApiKey: encryptedKey, adminNotificationEmail: adminEmail, emailFromAddress: fromAddress, emailFromName: fromNameVal },
  });
  return ok();
};

// ── Preview SVG icons (browser only — not used in sent emails) ────────────────

const PREVIEW_ICONS: Record<string, string> = {
  info: `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#eff6ff"/><circle cx="40" cy="40" r="26" stroke="#3b82f6" stroke-width="2.5" fill="none"/><circle cx="40" cy="30" r="2.5" fill="#3b82f6"/><line x1="40" y1="37" x2="40" y2="53" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  pending: `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#fff7ed"/><circle cx="40" cy="40" r="26" stroke="#f97316" stroke-width="2.5" fill="none"/><line x1="40" y1="22" x2="40" y2="40" stroke="#f97316" stroke-width="2.5" stroke-linecap="round"/><line x1="40" y1="40" x2="51" y2="47" stroke="#f97316" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  approved: `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#f0fdf4"/><circle cx="40" cy="40" r="26" stroke="#22c55e" stroke-width="2.5" fill="none"/><polyline points="28,41 36,49 53,31" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rejected: `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="40" cy="40" r="40" fill="#f8fafc"/><circle cx="40" cy="40" r="26" stroke="#94a3b8" stroke-width="2.5" fill="none"/><line x1="30" y1="30" x2="50" y2="50" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/><line x1="50" y1="30" x2="30" y2="50" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/></svg>`,
};

const PREVIEW_VARS: Record<string, string> = {
  customerName:  "Jane Smith",
  customerEmail: "jane@example.com",
  businessName:  "Smith Co.",
  shopName:      "your-store.myshopify.com",
  shopUrl:       "https://your-store.com",
  adminUrl:      "#",
};

function buildEmailPreviewHtml(blocks: EmailBlock[], _subject: string): string {
  const sub = (s: string) =>
    (s ?? "").replace(/\{\{(\w+)\}\}/g, (_, k) => PREVIEW_VARS[k] ?? `{{${k}}}`);
  const esc = (s: string) =>
    sub(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const rows = blocks.map((b): string => {
    switch (b.type) {
      case "header":
        return `<tr><td style="padding:40px 48px 8px;text-align:center;">
          <p style="margin:0;font-size:17px;font-weight:600;color:${b.bgColor ?? "#111827"};letter-spacing:-0.2px;font-family:-apple-system,sans-serif;">${esc(b.text ?? "")}</p>
        </td></tr>`;

      case "text": {
        const html = esc(b.content ?? "").replace(/\n/g, "<br/>");
        const fw = b.fontWeight === "bold" ? "700" : "400";
        const fs = b.fontSize ?? 15;
        const clr = b.color ?? (b.fontWeight === "bold" ? "#111827" : "#6b7280");
        return `<tr><td style="padding:8px 48px;">
          <p style="margin:0;font-size:${fs}px;color:${clr};font-weight:${fw};text-align:${b.align ?? "left"};line-height:1.7;font-family:-apple-system,sans-serif;">${html}</p>
        </td></tr>`;
      }

      case "image": {
        const w = b.imageWidth ?? 60;
        if (!b.imageUrl) {
          return `<tr><td style="padding:28px 48px 8px;text-align:${b.imageAlign ?? "center"};">
            <div style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:${w}%;max-width:320px;height:100px;background:#f8fafc;border-radius:8px;border:1.5px dashed #d1d5db;">
              <span style="font-size:28px;color:#d1d5db;line-height:1;">+</span>
              <div style="width:48px;height:1px;background:#d1d5db;margin:6px 0;"></div>
              <span style="font-size:11px;color:#94a3b8;font-family:-apple-system,sans-serif;">Image URL</span>
            </div>
          </td></tr>`;
        }
        return `<tr><td style="padding:28px 48px 8px;text-align:${b.imageAlign ?? "center"};">
          <img src="${sub(b.imageUrl)}" alt="${esc(b.imageAlt ?? "")}" style="display:inline-block;max-width:100%;width:${w}%;height:auto;" />
        </td></tr>`;
      }

      case "button": {
        const url   = sub(b.buttonUrl ?? "#");
        const label = esc(b.buttonLabel ?? "Click here");
        const bg    = b.buttonBg ?? "#2563eb";
        return `<tr><td style="padding:20px 48px;text-align:${b.buttonAlign ?? "center"};">
          <a href="${url}" style="display:inline-block;padding:14px 28px;background:${bg};color:${b.buttonTextColor ?? "#fff"};text-decoration:none;border-radius:100px;font-size:15px;font-weight:600;letter-spacing:-0.1px;font-family:-apple-system,sans-serif;">${label}</a>
        </td></tr>`;
      }

      case "divider": {
        const dc    = b.dividerColor ?? "#e5e7eb";
        const showP = b.showPlus !== false;
        if (showP) {
          return `<tr><td style="padding:16px 48px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="flex:1;height:1px;background:${dc};"></div>
              <span style="font-size:12px;color:#d1d5db;line-height:1;font-family:-apple-system,sans-serif;user-select:none;">+</span>
              <div style="flex:1;height:1px;background:${dc};"></div>
            </div>
          </td></tr>`;
        }
        return `<tr><td style="padding:16px 48px;">
          <div style="height:1px;background:${dc};"></div>
        </td></tr>`;
      }

      case "icon": {
        const svg = PREVIEW_ICONS[b.iconType ?? "info"] ?? PREVIEW_ICONS.info;
        return `<tr><td style="padding:32px 48px 8px;text-align:center;">${svg}</td></tr>`;
      }

      case "spacer":
        return `<tr><td style="height:${b.spacerHeight ?? 24}px;"></td></tr>`;

      case "footer": {
        const html = esc(b.content ?? "").replace(/\n/g, "<br/>");
        const termsLink = b.termsUrl
          ? `<br/><a href="${sub(b.termsUrl)}" style="color:${b.linkColor ?? b.color ?? "#9ca3af"};text-decoration:underline;">${esc(b.termsText ?? "Terms & Conditions")}</a>`
          : "";
        return `<tr><td style="padding:16px 48px 32px;border-top:1px solid #f5f5f5;">
          <p style="margin:0;font-size:12px;color:${b.color ?? "#9ca3af"};text-align:${b.align ?? "center"};line-height:1.7;font-family:-apple-system,sans-serif;">${html}${termsLink}</p>
        </td></tr>`;
      }

      case "terms": {
        const html = esc(b.content ?? "").replace(/\n/g, "<br/>");
        return `<tr><td style="padding:8px 48px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;line-height:1.7;font-style:italic;font-family:-apple-system,sans-serif;">${html}</p>
        </td></tr>`;
      }

      default: return "";
    }
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
  <body style="margin:0;padding:20px;background:#f5f5f5;font-family:-apple-system,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0"
          style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.07);">
          ${rows}
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

type EmailTab = "admin" | "pending" | "approved" | "rejected";

interface TemplateState {
  subject: string;
  enabled?: boolean;
  blocks: EmailBlock[];
}

export default function SettingsPage() {
  const data        = useLoaderData<typeof loader>();
  const fetcher     = useFetcher<typeof action>();
  const testFetcher = useFetcher<typeof action>();

  const [key,         setKey]         = useState(data.apiKey);
  const [email,       setEmail]       = useState(data.adminEmail);
  const [fromAddress, setFromAddress] = useState(data.fromAddress);
  const [fromName,    setFromName]    = useState(data.fromName);
  const [showKey,     setShowKey]     = useState(false);
  const [editing,     setEditing]     = useState(!data.keyConfigured);

  const [templates, setTemplates] = useState<Record<EmailTab, TemplateState>>({
    admin:    { subject: data.emailAdminSubject,    blocks: getBlocks("admin",    data.emailAdminBlocks) },
    pending:  { subject: data.emailPendingSubject,  enabled: data.emailPendingEnabled, blocks: getBlocks("pending",  data.emailPendingBlocks) },
    approved: { subject: data.emailApprovedSubject, blocks: getBlocks("approved", data.emailApprovedBlocks) },
    rejected: { subject: data.emailRejectedSubject, blocks: getBlocks("rejected", data.emailRejectedBlocks) },
  });
  const [activeTab,       setActiveTab]       = useState<EmailTab>("admin");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [dragActiveId,    setDragActiveId]    = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const tpl      = templates[activeTab];
  const blocks   = tpl.blocks;
  const selBlock = blocks.find(b => b.id === selectedBlockId) ?? null;

  const updateTpl    = (patch: Partial<TemplateState>) =>
    setTemplates(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], ...patch } }));
  const updateBlocks = (nb: EmailBlock[]) => updateTpl({ blocks: nb });
  const updateBlock  = (id: string, patch: Partial<EmailBlock>) =>
    updateBlocks(blocks.map(b => b.id === id ? { ...b, ...patch } : b));
  const addBlock     = (type: EmailBlockType) => {
    const nb = makeBlock(type);
    updateBlocks([...blocks, nb]);
    setSelectedBlockId(nb.id);
  };
  const deleteBlock  = (id: string) => {
    updateBlocks(blocks.filter(b => b.id !== id));
    if (selectedBlockId === id) setSelectedBlockId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDragActiveId(null);
    if (over && active.id !== over.id) {
      const oi = blocks.findIndex(b => b.id === active.id);
      const ni = blocks.findIndex(b => b.id === over.id);
      updateBlocks(arrayMove(blocks, oi, ni));
    }
  };

  const saving    = fetcher.state === "submitting";
  const fd_intent = fetcher.formData?.get("intent");
  const saved     = fetcher.data?.success && !fetcher.data?.cleared && !fetcher.data?.savedTemplates;
  const cleared   = fetcher.data?.cleared;
  const savedTpls = fetcher.data?.savedTemplates;

  const sendingTest  = testFetcher.state !== "idle";
  const testSent     = testFetcher.data?.testSent;
  const testError    = testFetcher.data?.testError;
  const testTemplate = (testFetcher.data?.testTemplate ?? testFetcher.formData?.get("template")) as string | null;

  const sendTest = (tab: EmailTab) => {
    testFetcher.submit({
      intent:   "test-email",
      template: tab,
      subject:  templates[tab].subject,
      blocks:   JSON.stringify(templates[tab].blocks),
    }, { method: "post" });
  };

  const saveKey = () => {
    fetcher.submit({ intent: "save", apiKey: key, adminEmail: email, fromAddress, fromName }, { method: "post" });
    setEditing(false);
  };

  const clearKey = () => {
    if (!window.confirm("Remove the saved API key?")) return;
    fetcher.submit({ intent: "clear-key" }, { method: "post" });
    setKey(""); setEditing(true);
  };

  const saveTemplates = () => {
    fetcher.submit({
      intent: "save-templates",
      emailAdminSubject:    templates.admin.subject,
      emailPendingEnabled:  String(templates.pending.enabled ?? false),
      emailPendingSubject:  templates.pending.subject,
      emailApprovedSubject: templates.approved.subject,
      emailRejectedSubject: templates.rejected.subject,
      emailAdminBlocks:     JSON.stringify(templates.admin.blocks),
      emailPendingBlocks:   JSON.stringify(templates.pending.blocks),
      emailApprovedBlocks:  JSON.stringify(templates.approved.blocks),
      emailRejectedBlocks:  JSON.stringify(templates.rejected.blocks),
    }, { method: "post" });
  };

  const previewHtml = buildEmailPreviewHtml(blocks, tpl.subject ?? "");

  return (
    <Page
      title="Settings"
      subtitle="Email notifications and template builder"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <BlockStack gap="500">

        {(saved || cleared || savedTpls) && (
          <Banner tone={cleared ? "warning" : "success"} onDismiss={() => {}}>
            {cleared ? "API key removed." : savedTpls ? "Email templates saved." : "Settings saved."}
          </Banner>
        )}

        {/* ── API key + from address ─────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Email notifications</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Sends new-application alerts to you and approval/rejection emails to customers.
                </Text>
              </BlockStack>
              <Badge tone={data.keyConfigured || !!key ? "success" : "attention"}>
                {data.keyConfigured || !!key ? "Configured" : "Not set up"}
              </Badge>
            </InlineStack>
            <Divider />
            <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 16 }}>✉</span>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Powered by{" "}
                  <a href="https://resend.com" target="_blank" rel="noreferrer" style={{ color: "#6366f1", fontWeight: 700, textDecoration: "none" }}>Resend</a>
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Free tier: 3,000 emails/month · 100/day. Sign up → API Keys → create key → paste below.
                </Text>
              </BlockStack>
            </div>

            {editing ? (
              <InlineStack gap="300" blockAlign="end">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Resend API key"
                    value={key}
                    onChange={setKey}
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    placeholder="re_••••••••••••••••••••••••"
                    helpText="Stored AES-256 encrypted. Never logged or shared."
                  />
                </div>
                <Button onClick={() => setShowKey(v => !v)}>{showKey ? "Hide" : "Show"}</Button>
              </InlineStack>
            ) : (
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="semibold">API key</Text>
                  <Text as="p" tone="subdued" variant="bodySm">re_••••••••••••{data.apiKey.slice(-4)}</Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button onClick={() => setEditing(true)}>Change key</Button>
                  <Button tone="critical" onClick={clearKey}>Remove</Button>
                </InlineStack>
              </InlineStack>
            )}

            <TextField
              label="Admin notification email"
              value={email}
              onChange={setEmail}
              type="email"
              autoComplete="off"
              placeholder="you@example.com"
              helpText="Gets alerted when a new wholesale application is submitted."
            />
            <TextField
              label="From name"
              value={fromName}
              onChange={setFromName}
              autoComplete="off"
              placeholder="B2B Wholesale"
              helpText="Displayed as the sender name in the customer's inbox."
            />
            {!fromAddress && (
              <Banner tone="warning" title="From address required — customer emails are failing">
                <p>Without a verified from address, Resend only delivers to your own account address. All customer emails are rejected silently.</p>
                <p style={{ marginTop: 8 }}>
                  Fix:{" "}
                  <a href="https://resend.com/domains" target="_blank" rel="noreferrer" style={{ color: "inherit", fontWeight: 600 }}>Verify a domain at resend.com/domains</a>
                  , then enter an email on that domain below and save.
                </p>
              </Banner>
            )}
            <TextField
              label="From address"
              value={fromAddress}
              onChange={setFromAddress}
              type="email"
              autoComplete="off"
              placeholder="info@yourdomain.com"
              helpText={
                fromAddress
                  ? "Emails sent from this address — domain must be verified in Resend."
                  : "Required for sending to customers. Must use a domain verified at resend.com/domains."
              }
            />
            <Button
              variant="primary"
              onClick={saveKey}
              loading={saving && fd_intent === "save"}
              disabled={editing && !key.trim()}
            >
              Save settings
            </Button>
          </BlockStack>
        </Card>

        {/* ── Email template builder ────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Email templates</Text>
                <Text as="p" tone="subdued" variant="bodySm">Drag blocks to reorder · click a block to edit · live preview below.</Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button
                  onClick={() => sendTest(activeTab)}
                  loading={sendingTest}
                  disabled={!data.keyConfigured || !data.adminEmail}
                  tone="success"
                >
                  Send test ✉
                </Button>
                <Button
                  variant="primary"
                  onClick={saveTemplates}
                  loading={saving && fd_intent === "save-templates"}
                >
                  Save templates
                </Button>
              </InlineStack>
            </InlineStack>

            <Divider />

            {testFetcher.state === "idle" && testFetcher.data && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
                borderRadius: 8, fontSize: 13,
                background: testSent ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${testSent ? "#bbf7d0" : "#fecaca"}`,
                color: testSent ? "#166534" : "#991b1b",
              }}>
                <span>{testSent ? "✓" : "✕"}</span>
                <span>
                  {testSent
                    ? `Test email sent to ${data.adminEmail} (${testTemplate} template)`
                    : testError ?? "Failed to send test email"}
                </span>
              </div>
            )}

            {/* Tab pills */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(["admin", "pending", "approved", "rejected"] as EmailTab[]).map(t => {
                const colors: Record<string, string> = { admin: "#303030", pending: "#f97316", approved: "#16a34a", rejected: "#4b5563" };
                return (
                  <button key={t} onClick={() => { setActiveTab(t); setSelectedBlockId(null); }}
                    style={{ padding: "6px 16px", borderRadius: 20, border: "1.5px solid", borderColor: activeTab === t ? colors[t] : "#e5e7eb", background: activeTab === t ? colors[t] : "#fff", color: activeTab === t ? "#fff" : "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                );
              })}
            </div>

            {/* Subject + enable (pending only) */}
            <div style={{ display: "grid", gridTemplateColumns: activeTab === "pending" ? "1fr auto" : "1fr", gap: 16, alignItems: "end" }}>
              <L label="Subject">
                <input value={tpl.subject} onChange={e => updateTpl({ subject: e.target.value })} placeholder="Email subject line" style={inputStyle} />
              </L>
              {activeTab === "pending" && (
                <div style={{ paddingBottom: 2 }}>
                  <Checkbox label="Enable" checked={tpl.enabled ?? false} onChange={v => updateTpl({ enabled: v })} helpText="Send on submit" />
                </div>
              )}
            </div>

            {/* Block palette */}
            <div>
              <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Add block</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {BLOCK_PALETTE.map(p => (
                  <button key={p.type} onClick={() => addBlock(p.type)} title={p.label}
                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 8, background: p.bg, border: `1px solid ${p.bg}`, color: p.fg, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    onMouseEnter={e => { (e.currentTarget as any).style.boxShadow = "0 2px 8px rgba(0,0,0,0.1)"; (e.currentTarget as any).style.transform = "translateY(-1px)"; }}
                    onMouseLeave={e => { (e.currentTarget as any).style.boxShadow = "none"; (e.currentTarget as any).style.transform = "none"; }}>
                    <span>{p.icon}</span> {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Editor + inspector */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20, alignItems: "start" }}>
              <div>
                {blocks.length === 0 ? (
                  <div style={{ border: "2px dashed #e5e7eb", borderRadius: 12, padding: "32px 16px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                    No blocks yet — add one from the palette above.
                  </div>
                ) : (
                  <DndContext sensors={sensors} collisionDetection={closestCenter}
                    onDragStart={(e: DragStartEvent) => setDragActiveId(e.active.id.toString())}
                    onDragEnd={handleDragEnd}>
                    <SortableContext items={blocks.map(b => b.id)} strategy={verticalListSortingStrategy}>
                      {blocks.map(b => (
                        <SortableEmailBlock key={b.id} block={b}
                          isSelected={selectedBlockId === b.id}
                          onSelect={() => setSelectedBlockId(prev => prev === b.id ? null : b.id)}
                          onDelete={() => deleteBlock(b.id)} />
                      ))}
                    </SortableContext>
                    <DragOverlay>
                      {dragActiveId && (() => {
                        const b = blocks.find(x => x.id === dragActiveId);
                        return b ? <BlockDragOverlay block={b} /> : null;
                      })()}
                    </DragOverlay>
                  </DndContext>
                )}
              </div>

              {/* Inspector */}
              <div style={{ position: "sticky", top: 16 }}>
                {selBlock ? (
                  <div style={{ background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                        {BLOCK_PALETTE.find(p => p.type === selBlock.type)?.icon} {selBlock.type.charAt(0).toUpperCase() + selBlock.type.slice(1)} block
                      </span>
                      <button onClick={() => setSelectedBlockId(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 18, lineHeight: 1 }}>×</button>
                    </div>
                    <BlockInspector block={selBlock} onChange={patch => updateBlock(selBlock.id, patch)} />
                  </div>
                ) : (
                  <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
                    <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Template variables</p>
                    {[
                      ["{{customerName}}", "Customer full name"],
                      ["{{customerEmail}}", "Customer email"],
                      ["{{businessName}}", "Business name"],
                      ["{{shopName}}", "Shop domain"],
                      ["{{shopUrl}}", "https://your-shop"],
                      ["{{adminUrl}}", "App review link"],
                    ].map(([v, d]) => (
                      <div key={v} style={{ marginBottom: 6 }}>
                        <code style={{ fontSize: 11, background: "#e0e7ff", color: "#3730a3", borderRadius: 4, padding: "2px 6px" }}>{v}</code>
                        <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6 }}>{d}</span>
                      </div>
                    ))}
                    <p style={{ margin: "12px 0 0", fontSize: 11, color: "#94a3b8" }}>Click a block to edit it.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Live preview */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#374151" }}>Live preview</p>
                <div style={{ display: "flex", alignItems: "center", gap: 4, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 20, padding: "2px 8px" }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#3b82f6" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", letterSpacing: "0.05em" }}>LIVE</span>
                </div>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>Updates as you edit · uses sample data for variables</span>
              </div>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", background: "#f5f5f5" }}>
                <iframe srcDoc={previewHtml} style={{ width: "100%", height: 400, border: "none", display: "block" }}
                  title="Email preview" sandbox="allow-same-origin"
                  onLoad={(e: React.SyntheticEvent<HTMLIFrameElement>) => {
                    const frame = e.currentTarget;
                    const body  = frame.contentDocument?.body;
                    if (body) frame.style.height = body.scrollHeight + "px";
                  }} />
              </div>
            </div>

          </BlockStack>
        </Card>

        {/* ── Usage card ────────────────────────────────────────────────────── */}
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Email usage</Text>
              <Text as="p" tone="subdued" variant="bodySm">View your sending quota and usage on Resend.</Text>
            </BlockStack>
            <a href="https://resend.com/settings/usage" target="_blank" rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#334155", textDecoration: "none", whiteSpace: "nowrap" }}>
              View on Resend ↗
            </a>
          </InlineStack>
        </Card>

      </BlockStack>
    </Page>
  );
}

// ── Sortable block item ───────────────────────────────────────────────────────

function SortableEmailBlock({ block, isSelected, onSelect, onDelete }: { block: EmailBlock; isSelected: boolean; onSelect: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const chip = BLOCK_CHIP_COLORS[block.type] ?? { bg: "#f1f5f9", fg: "#64748b" };
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${Math.round(transform.x)}px,${Math.round(transform.y)}px,0)` : undefined,
    transition,
    opacity: isDragging ? 0.35 : 1,
    display: "flex", alignItems: "center", gap: 10,
    padding: "9px 12px", marginBottom: 5,
    background: isSelected ? "#eef2ff" : "#fff",
    border: `1.5px solid ${isSelected ? "#6366f1" : "#e5e7eb"}`,
    borderRadius: 10, cursor: "pointer",
  };
  return (
    <div ref={setNodeRef} style={style} onClick={onSelect}>
      <span {...attributes} {...listeners} onClick={e => e.stopPropagation()}
        style={{ cursor: "grab", color: "#cbd5e1", fontSize: 18, lineHeight: 1, userSelect: "none", flexShrink: 0, touchAction: "none" }}>⠿</span>
      <span style={{ background: chip.bg, color: chip.fg, fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px", letterSpacing: "0.05em", flexShrink: 0, textTransform: "uppercase" }}>
        {block.type}
      </span>
      <span style={{ flex: 1, fontSize: 13, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {blockPreviewLabel(block)}
      </span>
      <button onClick={e => { e.stopPropagation(); onDelete(); }}
        style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 18, padding: "0 2px", lineHeight: 1, flexShrink: 0 }}>×</button>
    </div>
  );
}

function BlockDragOverlay({ block }: { block: EmailBlock }) {
  const chip = BLOCK_CHIP_COLORS[block.type] ?? { bg: "#f1f5f9", fg: "#64748b" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "#fff", border: "1.5px solid #6366f1", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", opacity: 0.92 }}>
      <span style={{ color: "#a5b4fc", fontSize: 18 }}>⠿</span>
      <span style={{ background: chip.bg, color: chip.fg, fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px", letterSpacing: "0.05em", textTransform: "uppercase" }}>{block.type}</span>
      <span style={{ fontSize: 13, color: "#374151" }}>{blockPreviewLabel(block)}</span>
    </div>
  );
}

// ── Block inspector ───────────────────────────────────────────────────────────

function BlockInspector({ block, onChange }: { block: EmailBlock; onChange: (p: Partial<EmailBlock>) => void }) {
  const iStyle = inputStyle;
  const rows: Record<string, React.ReactNode> = {
    header: (
      <BlockStack gap="300">
        <L label="Header text"><input style={iStyle} value={block.text ?? ""} onChange={e => onChange({ text: e.target.value })} /></L>
        <L label="Text color"><ColorRow value={block.bgColor ?? "#111827"} onChange={v => onChange({ bgColor: v })} /></L>
      </BlockStack>
    ),
    text: (
      <BlockStack gap="300">
        <L label="Content">
          <textarea style={{ ...iStyle, height: 100, resize: "vertical" }} value={block.content ?? ""} onChange={e => onChange({ content: e.target.value })} />
        </L>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <L label="Font size"><input style={iStyle} type="number" min={10} max={48} value={block.fontSize ?? 15} onChange={e => onChange({ fontSize: +e.target.value })} /></L>
          <L label="Color"><ColorRow value={block.color ?? "#374151"} onChange={v => onChange({ color: v })} /></L>
        </div>
        <L label="Alignment"><AlignRow value={block.align ?? "left"} onChange={v => onChange({ align: v as any })} /></L>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
          <input type="checkbox" checked={block.fontWeight === "bold"} onChange={e => onChange({ fontWeight: e.target.checked ? "bold" : "normal" })} /> Bold
        </label>
      </BlockStack>
    ),
    image: (
      <BlockStack gap="300">
        <L label="Image URL"><input style={iStyle} value={block.imageUrl ?? ""} onChange={e => onChange({ imageUrl: e.target.value })} placeholder="https://..." /></L>
        <L label="Alt text"><input style={iStyle} value={block.imageAlt ?? ""} onChange={e => onChange({ imageAlt: e.target.value })} /></L>
        <L label="Width (%)"><input style={iStyle} type="number" min={10} max={100} value={block.imageWidth ?? 100} onChange={e => onChange({ imageWidth: +e.target.value })} /></L>
        <L label="Alignment"><AlignRow value={block.imageAlign ?? "center"} onChange={v => onChange({ imageAlign: v as any })} /></L>
      </BlockStack>
    ),
    button: (
      <BlockStack gap="300">
        <L label="Button label"><input style={iStyle} value={block.buttonLabel ?? ""} onChange={e => onChange({ buttonLabel: e.target.value })} /></L>
        <L label="URL"><input style={iStyle} value={block.buttonUrl ?? ""} onChange={e => onChange({ buttonUrl: e.target.value })} placeholder="{{shopUrl}} or https://..." /></L>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <L label="Background"><ColorRow value={block.buttonBg ?? "#303030"} onChange={v => onChange({ buttonBg: v })} /></L>
          <L label="Text color"><ColorRow value={block.buttonTextColor ?? "#ffffff"} onChange={v => onChange({ buttonTextColor: v })} /></L>
        </div>
        <L label="Alignment"><AlignRow value={block.buttonAlign ?? "center"} onChange={v => onChange({ buttonAlign: v as any })} /></L>
      </BlockStack>
    ),
    icon: (
      <L label="Icon type">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["info", "pending", "approved", "rejected"] as const).map(t => {
            const colors: Record<string, string> = { info: "#3b82f6", pending: "#f97316", approved: "#22c55e", rejected: "#94a3b8" };
            return (
              <button key={t} onClick={() => onChange({ iconType: t })}
                style={{ flex: 1, padding: "6px 4px", borderRadius: 8, border: `2px solid ${block.iconType === t ? colors[t] : "#e5e7eb"}`, background: block.iconType === t ? `${colors[t]}18` : "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: colors[t] }}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            );
          })}
        </div>
      </L>
    ),
    divider: (
      <BlockStack gap="300">
        <L label="Line color"><ColorRow value={block.dividerColor ?? "#e5e7eb"} onChange={v => onChange({ dividerColor: v })} /></L>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
          <input type="checkbox" checked={block.showPlus !== false} onChange={e => onChange({ showPlus: e.target.checked })} /> Show + in center
        </label>
      </BlockStack>
    ),
    spacer: (
      <L label="Height (px)"><input style={iStyle} type="number" min={4} max={120} value={block.spacerHeight ?? 24} onChange={e => onChange({ spacerHeight: +e.target.value })} /></L>
    ),
    footer: (
      <BlockStack gap="300">
        <L label="Footer text">
          <textarea style={{ ...iStyle, height: 72, resize: "vertical" }} value={block.content ?? ""} onChange={e => onChange({ content: e.target.value })} />
        </L>
        <L label="Text color"><ColorRow value={block.color ?? "#9ca3af"} onChange={v => onChange({ color: v })} /></L>
        <L label="Alignment"><AlignRow value={block.align ?? "center"} onChange={v => onChange({ align: v as any })} /></L>
        <div style={{ marginTop: 4, paddingTop: 10, borderTop: "1px solid #e5e7eb" }}>
          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Terms link</p>
        </div>
        <L label="Link text"><input style={iStyle} value={block.termsText ?? ""} onChange={e => onChange({ termsText: e.target.value })} placeholder="Terms & Conditions" /></L>
        <L label="Link URL"><input style={iStyle} value={block.termsUrl ?? ""} onChange={e => onChange({ termsUrl: e.target.value })} placeholder="{{shopUrl}}/policies/terms-of-service" /></L>
        <L label="Link color"><ColorRow value={block.linkColor ?? "#9ca3af"} onChange={v => onChange({ linkColor: v })} /></L>
        <p style={{ margin: 0, fontSize: 11, color: "#94a3b8" }}>Leave URL empty to hide the terms link.</p>
      </BlockStack>
    ),
    terms: (
      <L label="Terms text">
        <textarea style={{ ...iStyle, height: 90, resize: "vertical" }} value={block.content ?? ""} onChange={e => onChange({ content: e.target.value })} />
      </L>
    ),
  };
  return <>{(rows as any)[block.type] ?? null}</>;
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ margin: "0 0 5px", fontSize: 12, fontWeight: 600, color: "#374151" }}>{label}</p>
      {children}
    </div>
  );
}

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input type="color" value={value} onChange={e => onChange(e.target.value)}
        style={{ width: 36, height: 36, border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer", padding: 2 }} />
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, flex: 1, fontFamily: "monospace", fontSize: 12 }} />
    </div>
  );
}

function AlignRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {(["left", "center", "right"] as const).map(a => (
        <button key={a} onClick={() => onChange(a)}
          style={{ flex: 1, padding: "5px 0", border: `1.5px solid ${value === a ? "#6366f1" : "#e5e7eb"}`, background: value === a ? "#eef2ff" : "#fff", color: value === a ? "#4f46e5" : "#64748b", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          {a === "left" ? "⬛▫▫" : a === "center" ? "▫⬛▫" : "▫▫⬛"}
        </button>
      ))}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px",
  border: "1px solid #e5e7eb", borderRadius: 7,
  fontSize: 13, outline: "none",
  background: "#fff", boxSizing: "border-box",
  color: "#111827",
};
