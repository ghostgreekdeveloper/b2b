/**
 * Email notifications via Resend.
 *
 * Each merchant provides their own Resend API key (stored in Form.resendApiKey).
 * If the key is absent the send is a no-op — the app works fine without email.
 *
 * All sends are fire-and-forget: call without await and email failure never
 * blocks or surfaces an error to the merchant or customer.
 *
 * From address: onboarding@resend.dev (Resend's shared domain — works for
 * every account with zero setup). For a custom domain the merchant verifies
 * it in their Resend dashboard and updates the FROM constant below.
 */

import { Resend } from "resend";
import { decrypt } from "./crypto.server";
import db from "./db.server";

const FROM_FALLBACK = "B2B Wholesale <onboarding@resend.dev>";

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#10003;/g, "✓").replace(/&#10005;/g, "✕")
    .replace(/&#9679;/g, "•").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Email block types (shared with settings UI) ───────────────────────────────

export type EmailBlockType =
  | "header" | "text" | "image" | "button"
  | "divider" | "spacer" | "footer" | "terms" | "icon";

export interface EmailBlock {
  id: string;
  type: EmailBlockType;
  // header
  bgColor?: string;
  textColor?: string;
  text?: string;
  // text / footer / terms
  content?: string;
  align?: "left" | "center" | "right";
  fontSize?: number;
  color?: string;
  fontWeight?: "normal" | "bold";
  // image
  imageUrl?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageAlign?: "left" | "center" | "right";
  // button
  buttonLabel?: string;
  buttonUrl?: string;
  buttonBg?: string;
  buttonTextColor?: string;
  buttonAlign?: "left" | "center" | "right";
  // divider
  dividerColor?: string;
  showPlus?: boolean;
  // spacer
  spacerHeight?: number;
  // icon
  iconType?: "info" | "pending" | "approved" | "rejected";
  // footer
  termsText?: string;
  termsUrl?: string;
  linkColor?: string;
}

export function parseEmailBlocks(raw: string): EmailBlock[] {
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length > 0) return p as EmailBlock[];
  } catch {}
  return [];
}

/**
 * Renders an array of EmailBlock objects to a full email HTML document.
 * vars: Record of {{variableName}} → replacement string substituted in all text content.
 */
export function renderEmailBlocks(
  blocks: EmailBlock[],
  vars: Record<string, string> = {},
): string {
  const sub = (s: string) =>
    (s ?? "").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
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
        if (!b.imageUrl) return "";
        const url = sub(b.imageUrl);
        const w = b.imageWidth ?? 60;
        return `<tr><td style="padding:28px 48px 8px;text-align:${b.imageAlign ?? "center"};">
          <img src="${url}" alt="${esc(b.imageAlt ?? "")}" style="display:inline-block;max-width:100%;width:${w}%;height:auto;" />
        </td></tr>`;
      }

      case "button": {
        const url = sub(b.buttonUrl ?? "#");
        const label = esc(b.buttonLabel ?? "Click here");
        const bg = b.buttonBg ?? "#2563eb";
        return `<tr><td style="padding:20px 48px;">
          <a href="${url}" style="display:block;padding:16px 24px;background:${bg};color:${b.buttonTextColor ?? "#ffffff"};text-decoration:none;border-radius:100px;font-size:15px;font-weight:600;text-align:center;letter-spacing:-0.1px;font-family:-apple-system,sans-serif;">${label}</a>
        </td></tr>`;
      }

      case "divider": {
        const dc = b.dividerColor ?? "#ebebeb";
        const showP = b.showPlus !== false;
        if (showP) {
          return `<tr><td style="padding:16px 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td width="46%" valign="middle" style="padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${dc};"><tr><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
              </td>
              <td style="padding:0 14px;font-size:12px;color:#c8c8c8;white-space:nowrap;text-align:center;font-family:-apple-system,sans-serif;line-height:1;">+</td>
              <td width="46%" valign="middle" style="padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${dc};"><tr><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
              </td>
            </tr></table>
          </td></tr>`;
        }
        return `<tr><td style="padding:16px 48px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${dc};"><tr><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
        </td></tr>`;
      }

      case "icon": {
        const iconDefs: Record<string, { outerBg: string; innerBorder: string; color: string; symbol: string; fontStyle: string }> = {
          info:     { outerBg: "#eff6ff", innerBorder: "#3b82f6", color: "#3b82f6", symbol: "i",  fontStyle: "italic" },
          pending:  { outerBg: "#fff7ed", innerBorder: "#f97316", color: "#f97316", symbol: "&#9711;", fontStyle: "normal" },
          approved: { outerBg: "#f0fdf4", innerBorder: "#22c55e", color: "#22c55e", symbol: "&#10003;", fontStyle: "normal" },
          rejected: { outerBg: "#f8fafc", innerBorder: "#94a3b8", color: "#94a3b8", symbol: "&#10005;", fontStyle: "normal" },
        };
        const ic = iconDefs[b.iconType ?? "info"] ?? iconDefs.info;
        return `<tr><td style="padding:32px 48px 8px;text-align:center;">
          <table cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;border-collapse:separate;">
            <tr><td align="center" valign="middle" width="64" height="64"
              style="width:64px;height:64px;border-radius:32px;background:${ic.outerBg};">
              <table cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;border-collapse:separate;">
                <tr><td align="center" valign="middle" width="40" height="40"
                  style="width:40px;height:40px;border-radius:20px;border:1.5px solid ${ic.innerBorder};color:${ic.color};font-size:18px;font-weight:700;font-style:${ic.fontStyle};font-family:Georgia,'Times New Roman',serif;line-height:40px;text-align:center;mso-line-height-rule:exactly;">${ic.symbol}</td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>`;
      }

      case "spacer":
        return `<tr><td style="height:${b.spacerHeight ?? 24}px;line-height:${b.spacerHeight ?? 24}px;">&nbsp;</td></tr>`;

      case "footer": {
        const html = esc(b.content ?? "").replace(/\n/g, "<br/>");
        const termsLink = b.termsUrl
          ? `<br/><a href="${sub(b.termsUrl)}" style="color:${b.linkColor ?? b.color ?? "#9ca3af"};text-decoration:underline;font-family:-apple-system,sans-serif;">${esc(b.termsText ?? "Terms &amp; Conditions")}</a>`
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
  }).filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 16px 64px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #ebebeb;overflow:hidden;">
        ${rows}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send helper ───────────────────────────────────────────────────────────────

interface EmailPayload {
  apiKey:      string;   // may be encrypted (AES-256-CBC iv:hex) or plain-text
  to:          string;
  subject:     string;
  html:        string;
  from?:       string;   // "Name <addr@domain.com>" — falls back to shared sandbox domain
  shopDomain?: string;   // if provided, monthly send counter is incremented
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const apiKey = decrypt(payload.apiKey);
  if (!apiKey || !payload.to) return;
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from:    payload.from || FROM_FALLBACK,
      to:      payload.to,
      subject: payload.subject,
      html:    payload.html,
      text:    htmlToText(payload.html),
    });
    if (error) {
      console.error("[email] Resend error:", error.message);
      return;
    }
    if (payload.shopDomain) trackSend(payload.shopDomain).catch(() => {});
  } catch (err) {
    console.error("[email] send failed:", err);
  }
}

/** Like sendEmail but returns success/error instead of swallowing — use for test sends. */
export async function sendEmailGetResult(payload: EmailPayload): Promise<{ ok: boolean; error: string | null }> {
  const apiKey = decrypt(payload.apiKey);
  if (!apiKey) return { ok: false, error: "No API key configured." };
  if (!payload.to) return { ok: false, error: "No recipient email configured." };
  try {
    const resend = new Resend(apiKey);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out after 15 seconds.")), 15_000)
    );
    const { error } = await Promise.race([
      resend.emails.send({
        from:    payload.from || FROM_FALLBACK,
        to:      payload.to,
        subject: payload.subject,
        html:    payload.html,
        text:    htmlToText(payload.html),
      }),
      timeout,
    ]) as Awaited<ReturnType<Resend["emails"]["send"]>>;
    if (error) return { ok: false, error: error.message };
    if (payload.shopDomain) trackSend(payload.shopDomain).catch(() => {});
    return { ok: true, error: null };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Unknown error" };
  }
}

async function trackSend(shopDomain: string): Promise<void> {
  const monthKey = new Date().toISOString().slice(0, 7); // "2026-06"
  // Atomic: reset counter when month rolls over, otherwise increment
  await db.$executeRaw`
    UPDATE "Form"
    SET "emailsSentMonth" = CASE WHEN "emailsMonthKey" = ${monthKey} THEN "emailsSentMonth" + 1 ELSE 1 END,
        "emailsMonthKey"  = ${monthKey}
    WHERE "shopDomain" = ${shopDomain}
  `;
}

// ── HTML templates ─────────────────────────────────────────────────────────────

const EMAIL_ICONS = {
  info:     `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="32" fill="#eff6ff"/><circle cx="32" cy="32" r="20" stroke="#3b82f6" stroke-width="2" fill="none"/><line x1="32" y1="29" x2="32" y2="41" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="24" r="1.5" fill="#3b82f6"/></svg>`,
  pending:  `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="32" fill="#fff7ed"/><circle cx="32" cy="32" r="20" stroke="#f97316" stroke-width="2" fill="none"/><line x1="32" y1="20" x2="32" y2="32" stroke="#f97316" stroke-width="2" stroke-linecap="round"/><line x1="32" y1="32" x2="40" y2="37" stroke="#f97316" stroke-width="2" stroke-linecap="round"/></svg>`,
  approved: `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="32" fill="#f0fdf4"/><circle cx="32" cy="32" r="20" stroke="#22c55e" stroke-width="2" fill="none"/><polyline points="22,33 28,39 42,25" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rejected: `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="32" fill="#f8fafc"/><circle cx="32" cy="32" r="20" stroke="#94a3b8" stroke-width="2" fill="none"/><line x1="25" y1="25" x2="39" y2="39" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/><line x1="39" y1="25" x2="25" y2="39" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/></svg>`,
};

function emailIcon(icon: keyof typeof EMAIL_ICONS): string {
  const defs = {
    info:     { outerBg: "#eff6ff", border: "#3b82f6", color: "#3b82f6", symbol: "i",         style: "italic" },
    pending:  { outerBg: "#fff7ed", border: "#f97316", color: "#f97316", symbol: "&#9711;",   style: "normal" },
    approved: { outerBg: "#f0fdf4", border: "#22c55e", color: "#22c55e", symbol: "&#10003;",  style: "normal" },
    rejected: { outerBg: "#f8fafc", border: "#94a3b8", color: "#94a3b8", symbol: "&#10005;",  style: "normal" },
  };
  const ic = defs[icon];
  return `<table cellpadding="0" cellspacing="0" align="center" style="margin:28px auto 8px;border-collapse:separate;">
    <tr><td align="center" valign="middle" width="72" height="72"
      style="width:72px;height:72px;border-radius:36px;background:${ic.outerBg};">
      <table cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;border-collapse:separate;">
        <tr><td align="center" valign="middle" width="46" height="46"
          style="width:46px;height:46px;border-radius:23px;border:2px solid ${ic.border};color:${ic.color};font-size:20px;font-weight:700;font-style:${ic.style};font-family:Georgia,'Times New Roman',serif;line-height:46px;text-align:center;mso-line-height-rule:exactly;">${ic.symbol}</td></tr>
      </table>
    </td></tr>
  </table>`;
}

function base(content: string, accentColor = "#2563eb", fromName = "B2B Wholesale"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${fromName}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 16px 64px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;">
        <!-- Brand wordmark above card -->
        <tr><td style="padding:0 0 28px;text-align:center;">
          <p style="margin:0;font-size:18px;font-weight:700;color:${accentColor};letter-spacing:-0.3px;font-family:-apple-system,sans-serif;">${fromName}</p>
        </td></tr>
        <!-- Card -->
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
            style="background:#ffffff;border-radius:16px;border:1px solid #ebebeb;overflow:hidden;">
            <tr><td style="padding:40px 48px 36px;">
              ${content}
            </td></tr>
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function btn(label: string, href: string, color: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
    <tr><td>
      <a href="${href}" style="display:block;padding:16px 24px;background:${color};color:#ffffff;text-decoration:none;border-radius:100px;font-size:15px;font-weight:600;text-align:center;letter-spacing:-0.1px;font-family:-apple-system,sans-serif;">${label}</a>
    </td></tr>
  </table>`;
}

// ─ Admin: new application ────────────────────────────────────────────────────

export interface NewApplicationData {
  customerName:  string;
  customerEmail: string;
  businessName:  string;
  shopName:      string;
  adminUrl:      string;
  accentColor?:  string;
  fromName?:     string;
}

export function newApplicationHtml(d: NewApplicationData): string {
  const accent = d.accentColor ?? "#2563eb";
  const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:0 12px;font-size:13px;color:#d1d5db;white-space:nowrap;vertical-align:middle;font-family:-apple-system,sans-serif;line-height:1;text-align:center;">+</td>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;

  const content = `
    ${emailIcon("info")}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;letter-spacing:-0.3px;line-height:1.3;font-family:-apple-system,sans-serif;">New wholesale application</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;text-align:center;line-height:1.7;font-family:-apple-system,sans-serif;">
      A customer just applied for a wholesale account on <strong style="color:#111827;">${d.shopName}</strong>.
    </p>
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.customerName || "—"}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">${d.customerEmail || "—"}</p>
    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">${d.businessName || "—"}</p>
    ${divider}
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.shopName}</p>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your team</p>
    <div style="height:1px;background:#ebebeb;margin:0 0 24px;"></div>
    ${btn("Review Application", d.adminUrl, accent)}`;

  return base(content, accent, d.fromName);
}

// ─ Customer: pending (application received) ───────────────────────────────────

export interface PendingData {
  customerName: string;
  shopName:     string;
  message:      string;
  accentColor?: string;
  fromName?:    string;
}

export function pendingHtml(d: PendingData): string {
  const accent = d.accentColor ?? "#f97316";
  const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:0 12px;font-size:13px;color:#d1d5db;white-space:nowrap;vertical-align:middle;font-family:-apple-system,sans-serif;line-height:1;text-align:center;">+</td>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;

  const content = `
    ${emailIcon("pending")}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;letter-spacing:-0.3px;line-height:1.3;font-family:-apple-system,sans-serif;">Application received!</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;text-align:center;line-height:1.7;font-family:-apple-system,sans-serif;">
      ${d.message.replace(/\n/g, "<br/>")}
    </p>
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.customerName || "—"}</p>
    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your wholesale account</p>
    ${divider}
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.shopName}</p>
    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your team</p>`;

  return base(content, accent, d.fromName);
}

// ─ Customer: approved ────────────────────────────────────────────────────────

export interface ApprovedData {
  customerName: string;
  shopName:     string;
  message:      string;
  shopUrl:      string;
  accentColor?: string;
  fromName?:    string;
}

export function approvedHtml(d: ApprovedData): string {
  const accent = d.accentColor ?? "#22c55e";
  const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:0 12px;font-size:13px;color:#d1d5db;white-space:nowrap;vertical-align:middle;font-family:-apple-system,sans-serif;line-height:1;text-align:center;">+</td>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;

  const content = `
    ${emailIcon("approved")}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;letter-spacing:-0.3px;line-height:1.3;font-family:-apple-system,sans-serif;">You're approved!</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;text-align:center;line-height:1.7;font-family:-apple-system,sans-serif;">
      ${d.message.replace(/\n/g, "<br/>")}
    </p>
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.customerName || "—"}</p>
    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your wholesale account</p>
    ${divider}
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.shopName}</p>
    <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your team</p>
    <div style="height:1px;background:#ebebeb;margin:0 0 24px;"></div>
    ${btn("Start Shopping", d.shopUrl, accent)}`;

  return base(content, accent, d.fromName);
}

// ─ Customer: rejected ────────────────────────────────────────────────────────

export interface RejectedData {
  customerName: string;
  shopName:     string;
  message:      string;
  accentColor?: string;
  fromName?:    string;
}

export function rejectedHtml(d: RejectedData): string {
  const accent = d.accentColor ?? "#94a3b8";
  const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:0 12px;font-size:13px;color:#d1d5db;white-space:nowrap;vertical-align:middle;font-family:-apple-system,sans-serif;line-height:1;text-align:center;">+</td>
    <td width="46%" style="border-top:1px solid #ebebeb;font-size:0;line-height:0;">&nbsp;</td>
  </tr></table>`;

  const content = `
    ${emailIcon("rejected")}
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;letter-spacing:-0.3px;line-height:1.3;font-family:-apple-system,sans-serif;">Update on your application</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;text-align:center;line-height:1.7;font-family:-apple-system,sans-serif;">
      ${d.message.replace(/\n/g, "<br/>")}
    </p>
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.customerName || "—"}</p>
    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your wholesale account</p>
    ${divider}
    <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#111827;text-align:center;font-family:-apple-system,sans-serif;">${d.shopName}</p>
    <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;font-family:-apple-system,sans-serif;">Your team</p>`;

  return base(content, accent, d.fromName);
}
