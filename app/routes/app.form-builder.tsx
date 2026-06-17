import React, { useState, useCallback, Fragment } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { json } from "@remix-run/node";
import {
  Page, Text, Button, TextField, Select,
  Checkbox, BlockStack, InlineStack, Divider,
  Modal, FormLayout,
} from "@shopify/polaris";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldType = "text" | "email" | "tel" | "number" | "textarea" | "select" | "radio" | "checkbox" | "terms" | "file";

interface FormField {
  id: string;
  type: FieldType;
  label: string;
  description: string;
  placeholder: string;
  required: boolean;
  hideLabel: boolean;
  saveAs: string;
  internalName: string;
  options: string[];
  content: string;
}

interface FormRow {
  id: string;
  fields: FormField[];
}

interface GlobalSettings {
  formName: string;
  formSubtitle: string;
  urlHandle: string;
  ctaButtonText: string;
  approvalMode: string;
  autoTag: string;
  autoExemptTax: boolean;
  submissionMessage: string;
  pendingTitle: string;
  pendingMessage: string;
  acceptedTitle: string;
  acceptedMessage: string;
  rejectedTitle: string;
  rejectedMessage: string;
  loginTitle: string;
  loginMessage: string;
}

interface AppearanceSettings {
  formWidth: string;
  fontSize: string;
  fontWeight: string;
  headingColor: string;
  labelColor: string;
  inputFieldColor: string;
  primaryButtonColor: string;
  secondaryButtonColor: string;
  backgroundColor: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 10); }

const SAVE_AS_OPTIONS = [
  { label: "— none (custom field) —", value: "" },
  { label: "First name", value: "firstName" },
  { label: "Last name", value: "lastName" },
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "Company / Business name", value: "businessName" },
  { label: "VAT / Tax ID", value: "taxId" },
  { label: "Address line 1", value: "address1" },
  { label: "Address line 2", value: "address2" },
  { label: "City", value: "city" },
  { label: "State / Province", value: "province" },
  { label: "ZIP / Postal code", value: "zip" },
  { label: "Country", value: "country" },
];

const FONT_WEIGHTS = [
  { label: "Light (300)", value: "300" },
  { label: "Regular (400)", value: "400" },
  { label: "Medium (500)", value: "500" },
  { label: "Semi-bold (600)", value: "600" },
  { label: "Bold (700)", value: "700" },
];

const APPROVAL_MODES = [
  { label: "Manual — admin reviews each application", value: "MANUAL" },
  { label: "Auto — approve all submissions instantly", value: "AUTO" },
];

const STANDARD_PALETTE = [
  { label: "First name",      type: "text"  as FieldType, saveAs: "firstName" },
  { label: "Last name",       type: "text"  as FieldType, saveAs: "lastName" },
  { label: "Email",           type: "email" as FieldType, saveAs: "email" },
  { label: "Phone",           type: "tel"   as FieldType, saveAs: "phone" },
  { label: "Company name",    type: "text"  as FieldType, saveAs: "businessName" },
  { label: "VAT / Tax ID",    type: "text"  as FieldType, saveAs: "taxId" },
  { label: "Address",         type: "text"  as FieldType, saveAs: "address1" },
  { label: "City",            type: "text"  as FieldType, saveAs: "city" },
  { label: "State / Region",  type: "text"  as FieldType, saveAs: "province" },
  { label: "ZIP code",        type: "text"  as FieldType, saveAs: "zip" },
  { label: "Country",         type: "text"  as FieldType, saveAs: "country" },
];

const CUSTOM_PALETTE = [
  { label: "Short text",          type: "text"     as FieldType, icon: "T" },
  { label: "Paragraph",           type: "textarea" as FieldType, icon: "¶" },
  { label: "Dropdown",            type: "select"   as FieldType, icon: "▼" },
  { label: "Multiple choice",     type: "radio"    as FieldType, icon: "◎" },
  { label: "Checkbox",            type: "checkbox" as FieldType, icon: "☑" },
  { label: "Terms & Conditions",  type: "terms"    as FieldType, icon: "§" },
  { label: "File upload",         type: "file"     as FieldType, icon: "↑" },
];

const BASE_FIELDS: FormField[] = [
  { id: "_fn",   type: "text",  label: "First name",        description: "", placeholder: "", required: true,  hideLabel: false, saveAs: "firstName",    internalName: "First name",  options: [], content: "" },
  { id: "_ln",   type: "text",  label: "Last name",         description: "", placeholder: "", required: true,  hideLabel: false, saveAs: "lastName",     internalName: "Last name",   options: [], content: "" },
  { id: "_em",   type: "email", label: "Email",             description: "", placeholder: "", required: true,  hideLabel: false, saveAs: "email",        internalName: "Email",       options: [], content: "" },
  { id: "_ph",   type: "tel",   label: "Phone",             description: "", placeholder: "", required: false, hideLabel: false, saveAs: "phone",        internalName: "Phone",       options: [], content: "" },
  { id: "_co",   type: "text",  label: "Company name",      description: "", placeholder: "", required: false, hideLabel: false, saveAs: "businessName", internalName: "Company",     options: [], content: "" },
  { id: "_vat",  type: "text",  label: "VAT / Tax ID",      description: "", placeholder: "", required: false, hideLabel: false, saveAs: "taxId",        internalName: "VAT ID",      options: [], content: "" },
  { id: "_addr", type: "text",  label: "Address",           description: "", placeholder: "", required: false, hideLabel: false, saveAs: "address1",     internalName: "Address",     options: [], content: "" },
  { id: "_city", type: "text",  label: "City",              description: "", placeholder: "", required: false, hideLabel: false, saveAs: "city",         internalName: "City",        options: [], content: "" },
  { id: "_st",   type: "text",  label: "State / Region",    description: "", placeholder: "", required: false, hideLabel: false, saveAs: "province",     internalName: "State",       options: [], content: "" },
  { id: "_zip",  type: "text",  label: "ZIP / Postal code", description: "", placeholder: "", required: false, hideLabel: false, saveAs: "zip",          internalName: "ZIP code",    options: [], content: "" },
  { id: "_ctry", type: "text",  label: "Country",           description: "", placeholder: "", required: false, hideLabel: false, saveAs: "country",      internalName: "Country",     options: [], content: "" },
];

const DEFAULT_ROWS: FormRow[] = [
  { id: "dr1", fields: [BASE_FIELDS[0],  BASE_FIELDS[1]] },
  { id: "dr2", fields: [BASE_FIELDS[2],  BASE_FIELDS[3]] },
  { id: "dr3", fields: [BASE_FIELDS[4],  BASE_FIELDS[5]] },
  { id: "dr4", fields: [BASE_FIELDS[6]] },
  { id: "dr5", fields: [BASE_FIELDS[7],  BASE_FIELDS[8]] },
  { id: "dr6", fields: [BASE_FIELDS[9],  BASE_FIELDS[10]] },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFieldFromPalette(p: { label: string; type: FieldType; saveAs?: string }): FormField {
  return {
    id: uid(), type: p.type, label: p.label, description: "", placeholder: "",
    required: false, hideLabel: false,
    saveAs: p.saveAs ?? "",
    internalName: p.label,
    options: p.type === "select" || p.type === "radio" ? ["Option 1", "Option 2"] : [],
    content: p.type === "terms" ? "I agree to the terms and conditions." : "",
  };
}

function parseRows(raw: string): FormRow[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_ROWS;
    // New format: rows with .fields property
    if (parsed[0]?.fields !== undefined) return parsed as FormRow[];
    // Old format: flat fields array — convert each to a row
    return (parsed as FormField[]).map((f) => ({ id: uid(), fields: [f] }));
  } catch {
    return DEFAULT_ROWS;
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: any) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await db.form.findFirst({ where: { shopDomain: shop } });

  const rows = parseRows((form?.formFields as string) || "[]");
  const settings: GlobalSettings = {
    formName:         (form?.formName as string)         ?? "Wholesale Registration Form",
    formSubtitle:     (form?.formSubtitle as string)     ?? "Fill in the details below to apply for a wholesale account.",
    urlHandle:        (form?.urlHandle as string)        ?? "register-wholesale",
    ctaButtonText:    (form?.ctaButtonText as string)    ?? "Submit Application",
    approvalMode:     (form?.approvalMode as string)     ?? "MANUAL",
    autoTag:          (form?.autoTag as string)          ?? "",
    autoExemptTax:    (form?.autoExemptTax as boolean)   ?? false,
    submissionMessage:(form?.submissionMessage as string)?? "Your application has been submitted!",
    pendingTitle:     (form?.pendingTitle as string)     ?? "Application Under Review",
    pendingMessage:   (form?.pendingMessage as string)   ?? "We've received your application and our team will review it shortly. We'll be in touch soon!",
    acceptedTitle:    (form?.acceptedTitle as string)    ?? "Wholesale Account Active",
    acceptedMessage:  (form?.acceptedMessage as string)  ?? "Your wholesale account is approved and active. Enjoy your exclusive pricing and access!",
    rejectedTitle:    (form?.rejectedTitle as string)    ?? "Application Not Approved",
    rejectedMessage:  (form?.rejectedMessage as string)  ?? "Unfortunately your application wasn't approved at this time. Please contact us if you have any questions.",
    loginTitle:       (form?.loginTitle as string)       ?? "Login Required",
    loginMessage:     (form?.loginMessage as string)     ?? "Please log in to your account to submit a wholesale application.",
  };
  const appearance: AppearanceSettings = {
    formWidth:           String((form?.formWidth as number)           ?? 600),
    fontSize:            String((form?.fontSize as number)            ?? 14),
    fontWeight:          (form?.fontWeight as string)                  ?? "400",
    headingColor:        (form?.headingColor as string)                ?? "#303030",
    labelColor:          (form?.labelColor as string)                  ?? "#303030",
    inputFieldColor:     (form?.inputFieldColor as string)             ?? "#303030",
    primaryButtonColor:  (form?.primaryButtonColor as string)          ?? "#303030",
    secondaryButtonColor:(form?.secondaryButtonColor as string)        ?? "#FFFFFF",
    backgroundColor:     (form?.backgroundColor as string)             ?? "#FFFFFF",
  };

  const shopifyPageId = (form?.shopifyPageId as string | null) ?? null;
  return json({ rows, settings, appearance, shop, shopifyPageId });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: any) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();

  // Delete page intent — deletes the Shopify page and unlocks the handle
  if (fd.get("intent") === "delete-page") {
    const existing = await db.form.findFirst({ where: { shopDomain: shop }, select: { shopifyPageId: true } });
    if (existing?.shopifyPageId) {
      try {
        await admin.graphql(
          `mutation DelPage($id:ID!){pageDelete(id:$id){deletedPageId userErrors{field message}}}`,
          { variables: { id: existing.shopifyPageId } },
        );
      } catch { /* non-fatal — still clear from DB */ }
    }
    await db.form.update({ where: { shopDomain: shop }, data: { shopifyPageId: null } });
    return json({ success: true, disconnected: true });
  }

  const body = JSON.parse(fd.get("data") as string);

  const handle = (body.settings.urlHandle || "register-wholesale")
    .replace(/[^a-z0-9-]/gi, "-").toLowerCase();

  const payload = {
    formFields:          JSON.stringify(body.rows),
    formName:            body.settings.formName,
    formSubtitle:        body.settings.formSubtitle,
    urlHandle:           handle,
    ctaButtonText:       body.settings.ctaButtonText,
    approvalMode:        body.settings.approvalMode,
    autoTag:             body.settings.autoTag,
    autoExemptTax:       body.settings.autoExemptTax,
    submissionMessage:   body.settings.submissionMessage,
    pendingTitle:        body.settings.pendingTitle,
    pendingMessage:      body.settings.pendingMessage,
    acceptedTitle:       body.settings.acceptedTitle,
    acceptedMessage:     body.settings.acceptedMessage,
    rejectedTitle:          body.settings.rejectedTitle,
    rejectedMessage:        body.settings.rejectedMessage,
    loginTitle:             body.settings.loginTitle,
    loginMessage:           body.settings.loginMessage,
    formWidth:           parseInt(body.appearance.formWidth, 10) || 600,
    fontSize:            parseInt(body.appearance.fontSize, 10) || 14,
    fontWeight:          body.appearance.fontWeight,
    headingColor:        body.appearance.headingColor,
    labelColor:          body.appearance.labelColor,
    inputFieldColor:     body.appearance.inputFieldColor,
    primaryButtonColor:  body.appearance.primaryButtonColor,
    secondaryButtonColor:body.appearance.secondaryButtonColor,
    backgroundColor:     body.appearance.backgroundColor,
  };

  await db.form.upsert({
    where: { shopDomain: shop },
    update: payload,
    create: { shopDomain: shop, status: true, ...payload },
  });

  let pageUrl: string | null = null;
  let pageId: string | null = null;
  let pageError: string | null = null;
  try {
    const result = await syncShopifyPage(admin, shop, handle, body.settings.formName || "Wholesale Registration");
    pageUrl = result.pageUrl;
    pageId = result.pageId;
  } catch (e: any) {
    pageError = String(e?.message ?? e);
    console.error("[form-builder] page sync failed:", pageError);
  }

  if (pageId) {
    try {
      await db.form.update({ where: { shopDomain: shop }, data: { shopifyPageId: pageId } });
    } catch { /* non-fatal */ }
  }

  return json({ success: true, pageUrl, pageId, pageError });
};

function buildEmbedBody(): string {
  // Auto-sizing iframe: the proxy page posts its scroll height via postMessage,
  // and the parent script updates the iframe height accordingly.
  const cs = "<" + "/script>";
  return (
    `<iframe id="b2b-wf" src="/a/b2b-wholesale/form" ` +
    `style="width:100%;border:none;min-height:500px;display:block" loading="lazy"></iframe>\n` +
    `<script>\n` +
    `window.addEventListener('message',function(e){\n` +
    `  if(e.data&&e.data.b2bH){document.getElementById('b2b-wf').style.height=e.data.b2bH+'px';}\n` +
    `});\n` +
    cs
  );
}

async function syncShopifyPage(
  admin: any,
  shop: string,
  handle: string,
  title: string,
): Promise<{ pageUrl: string; pageId: string | null }> {
  const body = buildEmbedBody();
  const pageUrl = `https://${shop}/pages/${handle}`;

  const findRes = await admin.graphql(
    `query FindPage($q:String!){pages(first:1,query:$q){nodes{id}}}`,
    { variables: { q: `handle:${handle}` } },
  );
  const findData = await findRes.json();
  const existing = findData?.data?.pages?.nodes?.[0];

  if (existing) {
    const r = await admin.graphql(
      `mutation Up($id:ID!,$p:PageUpdateInput!){pageUpdate(id:$id,page:$p){page{id}userErrors{field message}}}`,
      { variables: { id: existing.id, p: { body } } },
    );
    const rd = await r.json();
    const errs = rd?.data?.pageUpdate?.userErrors;
    if (errs?.length) throw new Error(errs[0].message);
    return { pageUrl, pageId: existing.id };
  }

  const r = await admin.graphql(
    `mutation Cr($p:PageCreateInput!){pageCreate(page:$p){page{id}userErrors{field message}}}`,
    { variables: { p: { title, handle, body } } },
  );
  const rd = await r.json();
  const errs = rd?.data?.pageCreate?.userErrors;
  if (errs?.length) throw new Error(errs[0].message);
  const page = rd?.data?.pageCreate?.page;
  return { pageUrl, pageId: page?.id ?? null };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FormBuilderPage() {
  const { rows: initRows, settings: initSettings, appearance: initAppearance, shop, shopifyPageId: initPageId } =
    useLoaderData<{ rows: FormRow[]; settings: GlobalSettings; appearance: AppearanceSettings; shop: string; shopifyPageId: string | null }>();

  const fetcher = useFetcher<{ success?: boolean; pageUrl?: string | null; pageId?: string | null; pageError?: string | null; disconnected?: boolean }>();

  const [rows, setRows] = useState<FormRow[]>(initRows);
  const [settings, setSettings] = useState<GlobalSettings>(initSettings);
  const [appearance, setAppearance] = useState<AppearanceSettings>(initAppearance);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"field" | "settings" | "appearance">("settings");
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);

  // DnD state
  const [activeField, setActiveField] = useState<FormField | null>(null);
  const [activeSource, setActiveSource] = useState<"palette" | "canvas" | null>(null);
  const [activePaletteData, setActivePaletteData] = useState<any | null>(null);
  const [overRowId, setOverRowId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Derive page ID directly from fetcher data so the UI updates immediately
  // without a useEffect→setState round-trip.
  const fd = fetcher.data;
  const shopifyPageId: string | null = fd?.disconnected ? null : (fd?.pageId ?? initPageId);

  const savedData = fetcher.state === "idle" ? fd : undefined;

  const handleDeletePage = useCallback(() => {
    fetcher.submit({ intent: "delete-page" }, { method: "post" });
  }, [fetcher]);

  // ── Helpers ──
  const allFields = rows.flatMap((r) => r.fields);
  const selectedField = allFields.find((f) => f.id === selectedId) ?? null;
  const allFieldIds = allFields.map((f) => f.id);

  const findRowFor = useCallback((fieldId: string) =>
    rows.find((r) => r.fields.some((f) => f.id === fieldId)), [rows]);

  const usedSaveAs = rows.flatMap((r) => r.fields.map((f) => f.saveAs)).filter(Boolean);

  // ── Field updates ──
  const updateField = useCallback(<K extends keyof FormField>(id: string, key: K, val: FormField[K]) => {
    setRows((prev) => prev.map((row) => ({
      ...row,
      fields: row.fields.map((f) => (f.id === id ? { ...f, [key]: val } : f)),
    })));
  }, []);

  const deleteField = useCallback((id: string) => {
    setRows((prev) =>
      prev
        .map((row) => ({ ...row, fields: row.fields.filter((f) => f.id !== id) }))
        .filter((row) => row.fields.length > 0)
    );
    if (selectedId === id) setSelectedId(null);
  }, [selectedId]);

  const extractField = useCallback((fieldId: string) => {
    setRows((prev) => {
      const sourceRow = prev.find((r) => r.fields.some((f) => f.id === fieldId));
      if (!sourceRow || sourceRow.fields.length <= 1) return prev;
      const field = sourceRow.fields.find((f) => f.id === fieldId)!;
      const sourceIdx = prev.findIndex((r) => r.id === sourceRow.id);
      const cleaned = prev.map((r) =>
        r.id === sourceRow.id ? { ...r, fields: r.fields.filter((f) => f.id !== fieldId) } : r
      );
      const result = [...cleaned];
      result.splice(sourceIdx + 1, 0, { id: uid(), fields: [field] });
      return result;
    });
  }, []);

  const moveInRow = useCallback((rowId: string, fieldId: string, dir: "left" | "right") => {
    setRows((prev) => prev.map((row) => {
      if (row.id !== rowId) return row;
      const idx = row.fields.findIndex((f) => f.id === fieldId);
      if (idx === -1) return row;
      const newIdx = dir === "left" ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= row.fields.length) return row;
      return { ...row, fields: arrayMove(row.fields, idx, newIdx) };
    }));
  }, []);

  // ── DnD handlers ──
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = event.active.id.toString();
    if (id.startsWith("palette:")) {
      setActiveSource("palette");
      setActivePaletteData(event.active.data.current);
      setActiveField(null);
    } else {
      setActiveSource("canvas");
      const field = allFields.find((f) => f.id === id) ?? null;
      setActiveField(field);
      setActivePaletteData(null);
    }
  }, [allFields]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over;
    if (!over) { setOverRowId(null); return; }
    const overId = over.id.toString();
    if (overId.startsWith("between:")) { setOverRowId(overId); return; }
    // over a field or row
    const row = rows.find((r) => r.id === overId) ??
      rows.find((r) => r.fields.some((f) => f.id === overId));
    setOverRowId(row?.id ?? null);
  }, [rows]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveField(null);
    setActiveSource(null);
    setActivePaletteData(null);
    setOverRowId(null);

    if (!over) return;

    const activeId = active.id.toString();
    const overId = over.id.toString();

    // ── Drop from palette ──
    if (activeId.startsWith("palette:")) {
      const paletteData = active.data.current as any;
      const newField = makeFieldFromPaletteItem(paletteData);

      if (overId.startsWith("between:")) {
        const parts = overId.split(":");
        const afterRowId = parts[1] === "null" ? null : parts[1];
        setRows((prev) => {
          const insertIdx = afterRowId === null ? 0 : prev.findIndex((r) => r.id === afterRowId) + 1;
          const next = [...prev];
          next.splice(insertIdx, 0, { id: uid(), fields: [newField] });
          return next;
        });
      } else {
        const targetRow = rows.find((r) => r.id === overId) ??
          rows.find((r) => r.fields.some((f) => f.id === overId));
        if (targetRow && targetRow.fields.length < 3) {
          setRows((prev) => prev.map((row) =>
            row.id === targetRow.id
              ? { ...row, fields: [...row.fields, newField] }
              : row
          ));
        } else {
          // Full row or nowhere — create new row at end
          setRows((prev) => [...prev, { id: uid(), fields: [newField] }]);
        }
      }
      setSelectedId(newField.id);
      setRightTab("field");
      return;
    }

    // ── Move canvas field ──
    const sourceRow = findRowFor(activeId);
    if (!sourceRow) return;

    if (overId.startsWith("between:")) {
      // Move to a new standalone row
      const parts = overId.split(":");
      const afterRowId = parts[1] === "null" ? null : parts[1];
      const field = sourceRow.fields.find((f) => f.id === activeId)!;
      setRows((prev) => {
        let next = prev
          .map((row) => ({ ...row, fields: row.fields.filter((f) => f.id !== activeId) }))
          .filter((row) => row.fields.length > 0);
        const insertIdx = afterRowId === null ? 0 : next.findIndex((r) => r.id === afterRowId) + 1;
        next.splice(insertIdx, 0, { id: uid(), fields: [field] });
        return next;
      });
      return;
    }

    // Over a field or row
    const targetRow = rows.find((r) => r.id === overId) ??
      rows.find((r) => r.fields.some((f) => f.id === overId));
    if (!targetRow) return;

    if (sourceRow.id === targetRow.id) {
      // Within-row reordering is done via ← / → buttons, not drag
    } else if (targetRow.fields.length < 3) {
      // Move to different row
      const field = sourceRow.fields.find((f) => f.id === activeId)!;
      setRows((prev) => {
        const removed = prev
          .map((row) => ({ ...row, fields: row.fields.filter((f) => f.id !== activeId) }))
          .filter((row) => row.fields.length > 0);
        return removed.map((row) =>
          row.id === targetRow.id ? { ...row, fields: [...row.fields, field] } : row
        );
      });
    }
  }, [rows, findRowFor]);

  function makeFieldFromPaletteItem(data: any): FormField {
    return makeFieldFromPalette({ label: data.label, type: data.fieldType, saveAs: data.saveAs });
  }

  const save = useCallback(() => {
    fetcher.submit(
      { data: JSON.stringify({ rows, settings, appearance }) },
      { method: "post" }
    );
  }, [rows, settings, appearance, fetcher]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <Page title="" fullWidth backAction={{ content: "Applications", url: "/app/applications" }}>
        <BlockStack gap="0">

          {/* ── Dark hero banner ── */}
          <div style={{
            position: "relative", overflow: "hidden", borderRadius: 16,
            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)",
            padding: "24px 28px 20px",
            boxShadow: "0 20px 60px rgba(15,23,42,0.18)",
            marginBottom: 20,
          }}>
            <div style={{ position: "absolute", top: -50, right: -50, width: 220, height: 220, borderRadius: "50%", background: "radial-gradient(circle, #6366f130 0%, transparent 70%)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", bottom: -60, left: 100, width: 180, height: 180, borderRadius: "50%", background: "radial-gradient(circle, #10b98120 0%, transparent 70%)", pointerEvents: "none" }} />
            <div style={{ position: "relative", zIndex: 1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "3px 12px", marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Form Builder</span>
                  </div>
                  <input
                    value={settings.formName}
                    onChange={(e) => setSettings((s) => ({ ...s, formName: e.target.value }))}
                    style={{ display: "block", fontSize: 24, fontWeight: 750, color: "#f8fafc", background: "transparent", border: "none", outline: "none", letterSpacing: "-0.03em", width: "100%" }}
                    placeholder="Form name"
                  />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, paddingTop: 28 }}>
                  {shopifyPageId && (
                    <a href={`https://${shop}/pages/${settings.urlHandle}`} target="_blank" rel="noreferrer" style={{ padding: "8px 16px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, color: "#e2e8f0", fontSize: 13, textDecoration: "none", fontWeight: 500 }}>
                      View page →
                    </a>
                  )}
                  <button
                    onClick={save}
                    disabled={fetcher.state === "submitting"}
                    style={{ padding: "8px 20px", background: "#6366f1", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: fetcher.state === "submitting" ? 0.65 : 1, transition: "opacity 0.15s" }}
                  >
                    {fetcher.state === "submitting" ? "Publishing…" : "Save & publish"}
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                {[
                  { label: "Fields", value: rows.flatMap((r) => r.fields).length },
                  { label: "Rows", value: rows.length },
                  { label: "Page", value: shopifyPageId ? "Published" : "Draft" },
                ].map((s) => (
                  <div key={s.label} style={{ background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: "8px 14px" }}>
                    <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 2 }}>{s.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 750, color: "#f1f5f9", letterSpacing: "-0.02em" }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Status banners ── */}
          {savedData?.success && !savedData?.disconnected && (
            <div style={{ marginBottom: 14, padding: "11px 16px", borderRadius: 10, background: savedData.pageError ? "#fef3c7" : "#f0fdf4", border: `1px solid ${savedData.pageError ? "#fcd34d" : "#86efac"}`, color: savedData.pageError ? "#92400e" : "#15803d", fontSize: 13 }}>
              {savedData.pageError
                ? <><strong>Form saved</strong>, but failed to publish page: {savedData.pageError}</>
                : savedData.pageUrl
                  ? <><strong>Published.</strong> <a href={savedData.pageUrl} target="_blank" rel="noreferrer" style={{ color: "#15803d" }}>View live page →</a></>
                  : <strong>Saved. Your form settings have been updated.</strong>}
            </div>
          )}
          {savedData?.disconnected && (
            <div style={{ marginBottom: 14, padding: "11px 16px", borderRadius: 10, background: "#eff6ff", border: "1px solid #93c5fd", color: "#1d4ed8", fontSize: 13 }}>
              Page deleted. You can now change the URL handle and re-publish.
            </div>
          )}

          {/* ── 3-column builder ── */}
          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 340px", gap: 16, alignItems: "start" }}>

            {/* Left: palette */}
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", position: "sticky", top: 16, maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", background: "#fafafa" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>Fields</span>
              </div>
              <div style={{ padding: "10px 10px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6, paddingLeft: 2 }}>Standard</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 10 }}>
                  {STANDARD_PALETTE.map((p) => (
                    <DraggablePaletteItem
                      key={p.saveAs}
                      id={`palette:std:${p.saveAs}`}
                      label={p.label}
                      icon="◈"
                      used={usedSaveAs.includes(p.saveAs)}
                      data={{ label: p.label, fieldType: p.type, saveAs: p.saveAs }}
                    />
                  ))}
                </div>
                <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0 10px" }} />
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6, paddingLeft: 2 }}>Custom</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {CUSTOM_PALETTE.map((p) => (
                    <DraggablePaletteItem
                      key={p.type + p.label}
                      id={`palette:cust:${p.type}:${p.label}`}
                      label={p.label}
                      icon={p.icon}
                      data={{ label: p.label, fieldType: p.type, saveAs: "" }}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Center: canvas + live preview */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflow: "hidden" }}>
              <div style={{ padding: "10px 20px", borderBottom: "1px solid #f1f5f9", background: "#fafafa", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>Canvas</span>
                <button
                  onClick={() => { if (window.confirm("Reset form to default fields?")) setRows(DEFAULT_ROWS); }}
                  style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", background: "none", border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 10px", cursor: "pointer", letterSpacing: "0.02em" }}
                >
                  Reset form
                </button>
              </div>
              <div style={{ padding: "12px 16px 20px" }}>
                <BetweenZone id={`between:null:${rows[0]?.id ?? "end"}`} isOver={overRowId === `between:null:${rows[0]?.id ?? "end"}`} />
                {rows.length === 0 ? (
                  <EmptyCanvas />
                ) : (
                  rows.map((row, idx) => (
                    <Fragment key={row.id}>
                      <CanvasRow
                        row={row}
                        selectedId={selectedId}
                        isOver={overRowId === row.id}
                        onSelect={(id) => { setSelectedId(id); setRightTab("field"); }}
                        onDelete={deleteField}
                        allFieldIds={allFieldIds}
                        onExtract={extractField}
                        onMoveInRow={moveInRow}
                      />
                      <BetweenZone
                        id={`between:${row.id}:${rows[idx + 1]?.id ?? "end"}`}
                        isOver={overRowId === `between:${row.id}:${rows[idx + 1]?.id ?? "end"}`}
                      />
                    </Fragment>
                  ))
                )}
              </div>
            </div>

              {/* Live form preview */}
              <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflow: "hidden" }}>
                <div style={{ padding: "10px 20px", borderBottom: "1px solid #f1f5f9", background: "#fafafa", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>Live preview</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 20, padding: "2px 8px" }}>
                    <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#3b82f6" }} />
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", letterSpacing: "0.05em" }}>LIVE</span>
                  </div>
                </div>
                <iframe
                  srcDoc={buildPreviewHtml(rows, settings, appearance)}
                  style={{ width: "100%", height: 400, border: "none", display: "block" }}
                  title="Form live preview"
                  sandbox="allow-same-origin"
                  onLoad={(e: React.SyntheticEvent<HTMLIFrameElement>) => {
                    const frame = e.currentTarget;
                    const body = frame.contentDocument?.body;
                    if (body) frame.style.height = body.scrollHeight + "px";
                  }}
                />
              </div>
            </div>{/* end center column */}

            {/* Right: settings panel */}
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", position: "sticky", top: 16, maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}>
              <div style={{ padding: "8px 8px 0", background: "#fafafa", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ display: "flex", gap: 3, background: "#f1f5f9", borderRadius: 8, padding: 3 }}>
                  {selectedField && <TabBtn label="Field" active={rightTab === "field"} onClick={() => setRightTab("field")} />}
                  <TabBtn label="Form" active={rightTab === "settings"} onClick={() => setRightTab("settings")} />
                  <TabBtn label="Style" active={rightTab === "appearance"} onClick={() => setRightTab("appearance")} />
                </div>
              </div>
              <div style={{ padding: "16px" }}>
                {rightTab === "field" && selectedField ? (
                  <FieldSettingsPanel
                    field={selectedField}
                    update={updateField}
                    onDelete={() => deleteField(selectedField.id)}
                    onOpenOptions={() => setOptionsModalOpen(true)}
                  />
                ) : rightTab === "settings" ? (
                  <GlobalSettingsPanel
                    settings={settings}
                    setSettings={setSettings}
                    shop={shop}
                    shopifyPageId={shopifyPageId}
                    onDisconnect={handleDeletePage}
                  />
                ) : (
                  <AppearancePanel appearance={appearance} setAppearance={setAppearance} />
                )}
              </div>
            </div>

          </div>
        </BlockStack>
      </Page>

      <DragOverlay>
        {activeSource === "canvas" && activeField ? (
          <FieldCardOverlay field={activeField} />
        ) : activeSource === "palette" && activePaletteData ? (
          <PaletteItemOverlay label={activePaletteData.label} />
        ) : null}
      </DragOverlay>

      {selectedField && (selectedField.type === "select" || selectedField.type === "radio") && (
        <Modal
          open={optionsModalOpen}
          onClose={() => setOptionsModalOpen(false)}
          title={`Options for "${selectedField.label}"`}
          primaryAction={{ content: "Done", onAction: () => setOptionsModalOpen(false) }}
        >
          <Modal.Section>
            <OptionsEditor
              options={selectedField.options}
              onChange={(opts) => updateField(selectedField.id, "options", opts)}
            />
          </Modal.Section>
        </Modal>
      )}

    </DndContext>
  );
}

// ─── DnD sub-components ───────────────────────────────────────────────────────

function DraggablePaletteItem({
  id, label, icon, used, data,
}: { id: string; label: string; icon: string; used?: boolean; data: any }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "7px 10px",
        background: used ? "#f0fdf4" : "#fff",
        border: used ? "1.5px solid #86efac" : "1.5px solid #e5e7eb",
        borderRadius: 9, cursor: "grab", userSelect: "none",
        fontSize: 12.5, color: used ? "#15803d" : "#1e293b",
        opacity: isDragging ? 0.35 : 1,
        transition: "box-shadow 0.1s, border-color 0.1s",
        boxShadow: isDragging ? "none" : "0 1px 2px rgba(0,0,0,0.04)",
        fontWeight: 500,
      }}
    >
      <span style={{
        width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
        background: used ? "#dcfce7" : "#f1f5f9",
        borderRadius: 5, fontSize: 11, fontWeight: 700,
        color: used ? "#16a34a" : "#64748b", flexShrink: 0,
      }}>{icon}</span>
      <span style={{ flex: 1, lineHeight: 1.2 }}>{label}</span>
      {used && <span style={{ fontSize: 10, color: "#16a34a", fontWeight: 700 }}>✓</span>}
    </div>
  );
}

function BetweenZone({ id, isOver }: { id: string; isOver: boolean }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        height: isOver ? 36 : 8,
        margin: "2px 0",
        borderRadius: 8,
        background: isOver ? "#eef2ff" : "transparent",
        border: isOver ? "2px dashed #6366f1" : "2px dashed transparent",
        transition: "all 0.15s",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {isOver && <span style={{ fontSize: 11, color: "#6366f1", fontWeight: 700 }}>New row here</span>}
    </div>
  );
}

function CanvasRow({
  row, selectedId, isOver, onSelect, onDelete, allFieldIds, onExtract, onMoveInRow,
}: {
  row: FormRow; selectedId: string | null; isOver: boolean;
  onSelect: (id: string) => void; onDelete: (id: string) => void;
  allFieldIds: string[];
  onExtract: (fieldId: string) => void;
  onMoveInRow: (rowId: string, fieldId: string, dir: "left" | "right") => void;
}) {
  const { setNodeRef } = useDroppable({ id: row.id, data: { rowId: row.id } });

  return (
    <div
      ref={setNodeRef}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${row.fields.length}, 1fr)`,
        gap: 12,
        padding: 6,
        borderRadius: 8,
        border: isOver ? "2px dashed #6366f1" : "2px solid transparent",
        background: isOver ? "#f8f7ff" : "transparent",
        transition: "all 0.15s",
        minHeight: 72,
      }}
    >
      {row.fields.map((field, idx) => (
        <DraggableFieldCard
          key={field.id}
          field={field}
          fieldCount={row.fields.length}
          isSelected={selectedId === field.id}
          onSelect={() => onSelect(field.id)}
          onDelete={() => onDelete(field.id)}
          onExtract={() => onExtract(field.id)}
          onMoveLeft={idx > 0 ? () => onMoveInRow(row.id, field.id, "left") : undefined}
          onMoveRight={idx < row.fields.length - 1 ? () => onMoveInRow(row.id, field.id, "right") : undefined}
        />
      ))}
    </div>
  );
}

function DraggableFieldCard({
  field, fieldCount, isSelected, onSelect, onDelete, onExtract, onMoveLeft, onMoveRight,
}: {
  field: FormField; fieldCount: number; isSelected: boolean;
  onSelect: () => void; onDelete: () => void;
  onExtract: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: field.id,
    data: { fieldId: field.id },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0 : 1 }}
    >
      <FieldCard
        field={field}
        fieldCount={fieldCount}
        isSelected={isSelected}
        onSelect={onSelect}
        onDelete={onDelete}
        onExtract={onExtract}
        onMoveLeft={onMoveLeft}
        onMoveRight={onMoveRight}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function FieldCard({
  field, fieldCount, isSelected, onSelect, onDelete, onExtract, onMoveLeft, onMoveRight, dragHandleProps,
}: {
  field: FormField; fieldCount: number; isSelected: boolean;
  onSelect: () => void; onDelete: () => void;
  onExtract: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  dragHandleProps?: any;
}) {
  const btnBase: React.CSSProperties = {
    padding: "2px 7px", fontSize: 10, border: "1px solid #e2e8f0",
    borderRadius: 5, background: "#f8fafc", color: "#64748b",
    cursor: "pointer", fontWeight: 600, lineHeight: 1.4,
  };
  return (
    <div
      onClick={onSelect}
      style={{
        border: isSelected ? "2px solid #6366f1" : "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "10px 12px",
        background: isSelected ? "#f8f7ff" : "#fff",
        cursor: "pointer",
        userSelect: "none",
        position: "relative",
        boxShadow: isSelected ? "0 0 0 3px rgba(99,102,241,0.12)" : "0 1px 2px rgba(0,0,0,0.04)",
        transition: "all 0.12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          <span
            {...dragHandleProps}
            style={{ cursor: "grab", color: "#cbd5e1", fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >⠿</span>
          {!field.hideLabel && (
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {field.label}
            </span>
          )}
          {field.required && <span style={{ color: "#ef4444", fontSize: 11, flexShrink: 0 }}>*</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: "#94a3b8", background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontWeight: 700 }}>
            {fieldCount === 1 ? "100%" : fieldCount === 2 ? "50%" : "33%"}
          </span>
          {isSelected && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              style={{ padding: "2px 6px", fontSize: 10, border: "1px solid #fca5a5", borderRadius: 5, background: "#fef2f2", color: "#ef4444", cursor: "pointer", fontWeight: 700 }}
            >✕</button>
          )}
        </div>
      </div>
      <FieldInputPreview field={field} />
      {/* Row controls — only shown when field is selected AND in a multi-field row */}
      {isSelected && fieldCount > 1 && (
        <div style={{ display: "flex", gap: 4, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          {onMoveLeft && (
            <button onClick={onMoveLeft} style={btnBase} title="Move left">← Left</button>
          )}
          {onMoveRight && (
            <button onClick={onMoveRight} style={btnBase} title="Move right">Right →</button>
          )}
          <button
            onClick={onExtract}
            style={{ ...btnBase, marginLeft: "auto", color: "#6366f1", borderColor: "#c7d2fe", background: "#f8f7ff" }}
            title="Move to own row"
          >⤢ Own row</button>
        </div>
      )}
    </div>
  );
}

function FieldCardOverlay({ field }: { field: FormField }) {
  return (
    <div style={{
      padding: "10px 14px", background: "#fff", border: "2px solid #6366f1",
      borderRadius: 10, boxShadow: "0 8px 32px rgba(99,102,241,0.25)", minWidth: 160,
      opacity: 0.92,
    }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{field.label}</span>
    </div>
  );
}

function PaletteItemOverlay({ label }: { label: string }) {
  return (
    <div style={{
      padding: "8px 14px", background: "#0f172a", color: "#f1f5f9",
      borderRadius: 8, boxShadow: "0 8px 24px rgba(15,23,42,0.3)",
      fontSize: 13, fontWeight: 600,
    }}>
      + {label}
    </div>
  );
}

function EmptyCanvas() {
  const { setNodeRef, isOver } = useDroppable({ id: "empty-canvas" });
  return (
    <div
      ref={setNodeRef}
      style={{
        padding: "56px 24px", textAlign: "center",
        border: isOver ? "2px dashed #6366f1" : "2px dashed #e2e8f0",
        borderRadius: 12, background: isOver ? "#f8f7ff" : "#fafafa",
        transition: "all 0.15s",
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.35 }}>⊞</div>
      <div style={{ fontSize: 13, color: "#94a3b8", fontWeight: 500 }}>
        {isOver ? "Drop here to add a field" : "Drag fields from the panel"}
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "6px 0", background: active ? "#fff" : "transparent",
        border: "none", borderRadius: 6,
        boxShadow: active ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
        fontWeight: active ? 600 : 400, fontSize: 12.5, cursor: "pointer",
        color: active ? "#0f172a" : "#64748b", transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );
}

function FieldInputPreview({ field }: { field: FormField }) {
  const s: React.CSSProperties = {
    width: "100%", padding: "5px 8px", border: "1px solid #c9cccf", borderRadius: 5,
    fontSize: 12, color: "#6d7175", background: "#f9f9f9", pointerEvents: "none",
  };
  if (field.type === "textarea")
    return <textarea style={{ ...s, height: 40, resize: "none" }} placeholder={field.placeholder || "…"} readOnly />;
  if (field.type === "select")
    return <select style={s}><option>— select —</option>{field.options.slice(0, 3).map((o, i) => <option key={i}>{o}</option>)}</select>;
  if (field.type === "radio")
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
        {field.options.slice(0, 2).map((o, i) => (
          <label key={i} style={{ fontSize: 11, color: "#6d7175", display: "flex", gap: 5 }}>
            <input type="radio" readOnly /> {o}
          </label>
        ))}
      </div>
    );
  if (field.type === "checkbox" || field.type === "terms")
    return <label style={{ fontSize: 11, color: "#6d7175", display: "flex", gap: 5 }}><input type="checkbox" readOnly /> <span>{field.type === "terms" ? field.content || "I agree…" : field.label}</span></label>;
  if (field.type === "file")
    return <div style={{ ...s }}>Choose file…</div>;
  return <input style={s} placeholder={field.placeholder || field.label} readOnly />;
}

function FieldSettingsPanel({
  field, update, onDelete, onOpenOptions,
}: {
  field: FormField;
  update: <K extends keyof FormField>(id: string, k: K, v: FormField[K]) => void;
  onDelete: () => void;
  onOpenOptions: () => void;
}) {
  const u = <K extends keyof FormField>(k: K, v: FormField[K]) => update(field.id, k, v);
  return (
    <BlockStack gap="400">
      <div style={{ padding: "8px 12px", background: "#f8f7ff", borderRadius: 8, border: "1px solid #e0e7ff" }}>
        <div style={{ fontSize: 9.5, color: "#6366f1", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 2 }}>Editing field</div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#1e1b4b" }}>{field.label || "Untitled field"}</div>
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{field.type}</div>
      </div>
      <TextField label="Label" value={field.label} onChange={(v) => u("label", v)} autoComplete="off" />
      <TextField label="Description" value={field.description} onChange={(v) => u("description", v)} autoComplete="off"
        helpText="Optional helper text shown below the field." />
      <Select label="Save as" options={SAVE_AS_OPTIONS} value={field.saveAs} onChange={(v) => u("saveAs", v)}
        helpText="Maps to customer profile field." />
      {(field.type === "select" || field.type === "radio") && (
        <Button onClick={onOpenOptions}>{`Edit options (${field.options.length})`}</Button>
      )}
      {field.type === "terms" && (
        <TextField label="Terms text" value={field.content} onChange={(v) => u("content", v)} multiline={3} autoComplete="off" />
      )}
      <TextField label="Placeholder" value={field.placeholder} onChange={(v) => u("placeholder", v)} autoComplete="off" />
      <Checkbox label="Required" checked={field.required} onChange={(v) => u("required", v)} />
      <Checkbox label="Hide label" checked={field.hideLabel} onChange={(v) => u("hideLabel", v)} />
      <TextField label="Internal field name" value={field.internalName} onChange={(v) => u("internalName", v)} autoComplete="off"
        helpText="Used in exports. Not shown to customers." />
      <Divider />
      <Button tone="critical" onClick={onDelete}>Remove field</Button>
    </BlockStack>
  );
}

function GlobalSettingsPanel({
  settings, setSettings, shop, shopifyPageId, onDisconnect,
}: {
  settings: GlobalSettings;
  setSettings: React.Dispatch<React.SetStateAction<GlobalSettings>>;
  shop: string;
  shopifyPageId: string | null;
  onDisconnect: () => void;
}) {
  const set = <K extends keyof GlobalSettings>(k: K, v: GlobalSettings[K]) =>
    setSettings((p) => ({ ...p, [k]: v }));
  const pageUrl = `https://${shop}/pages/${settings.urlHandle}`;

  const [statusTab, setStatusTab] = useState<"pending" | "accepted" | "rejected" | "login">("pending");

  return (
    <BlockStack gap="400">
      <TextField label="Form subtitle" value={settings.formSubtitle} onChange={(v) => set("formSubtitle", v)} multiline={2} autoComplete="off"
        helpText="Shown below the form title." />
      <TextField label="CTA button label" value={settings.ctaButtonText} onChange={(v) => set("ctaButtonText", v)} autoComplete="off" />

      {/* URL handle — locked once a page is published */}
      <div>
        <Text as="p" variant="bodyMd" fontWeight="medium">Registration form URL</Text>
        {shopifyPageId ? (
          <BlockStack gap="100">
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              background: "#f8f7ff", border: "1px solid #c7d2fe", borderRadius: 10,
              padding: "10px 14px", marginTop: 6,
            }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>🔒</span>
              <span style={{ fontSize: 12, color: "#1e293b", wordBreak: "break-all", fontWeight: 500 }}>{pageUrl}</span>
            </div>
            <Text as="p" variant="bodySm" tone="subdued">
              Handle is locked while the page is live. Delete page to change it.
            </Text>
          </BlockStack>
        ) : (
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">{`https://${shop}/pages/`}</Text>
            <TextField
              label="" labelHidden
              value={settings.urlHandle}
              onChange={(v) => set("urlHandle", v.replace(/[^a-z0-9-]/gi, "-").toLowerCase())}
              autoComplete="off"
            />
          </BlockStack>
        )}
      </div>

      <Select label="Registration approval" options={APPROVAL_MODES} value={settings.approvalMode} onChange={(v) => set("approvalMode", v)} />
      <TextField label="Auto tag customers" value={settings.autoTag} onChange={(v) => set("autoTag", v)} autoComplete="off"
        helpText="Tag applied to approved customers." />
      <Checkbox label="Auto exempt tax for approved customers" checked={settings.autoExemptTax} onChange={(v) => set("autoExemptTax", v)} />
      <TextField label="Submission message" value={settings.submissionMessage} onChange={(v) => set("submissionMessage", v)} multiline={2} autoComplete="off"
        helpText="Shown after the customer submits the form." />

      <Divider />

      {/* Status page messages */}
      <div>
        <Text as="p" variant="bodyMd" fontWeight="medium">Status page messages</Text>
        <Text as="p" variant="bodySm" tone="subdued">Customize what customers see on their status page.</Text>
      </div>
      <div style={{ display: "flex", gap: 3, background: "#f1f5f9", borderRadius: 8, padding: 3 }}>
        {(["pending", "accepted", "rejected", "login"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setStatusTab(tab)}
            style={{
              flex: 1, padding: "5px 0",
              background: statusTab === tab ? "#fff" : "transparent",
              border: "none", borderRadius: 6,
              boxShadow: statusTab === tab ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              fontWeight: statusTab === tab ? 600 : 400, fontSize: 12, cursor: "pointer",
              color: statusTab === tab
                ? tab === "pending" ? "#b45309" : tab === "accepted" ? "#15803d" : tab === "rejected" ? "#b91c1c" : "#2563eb"
                : "#64748b",
              transition: "all 0.15s",
            }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {statusTab === "pending" && (
        <BlockStack gap="300">
          <TextField label="Title" value={settings.pendingTitle} onChange={(v) => set("pendingTitle", v)} autoComplete="off" />
          <TextField label="Message" value={settings.pendingMessage} onChange={(v) => set("pendingMessage", v)} multiline={4} autoComplete="off"
            helpText="Add a line break to include phone, email, or any contact info below the message." />
        </BlockStack>
      )}
      {statusTab === "accepted" && (
        <BlockStack gap="300">
          <TextField label="Title" value={settings.acceptedTitle} onChange={(v) => set("acceptedTitle", v)} autoComplete="off" />
          <TextField label="Message" value={settings.acceptedMessage} onChange={(v) => set("acceptedMessage", v)} multiline={4} autoComplete="off"
            helpText="Add a line break to include phone, email, or any contact info below the message." />
        </BlockStack>
      )}
      {statusTab === "rejected" && (
        <BlockStack gap="300">
          <TextField label="Title" value={settings.rejectedTitle} onChange={(v) => set("rejectedTitle", v)} autoComplete="off" />
          <TextField label="Message" value={settings.rejectedMessage} onChange={(v) => set("rejectedMessage", v)} multiline={4} autoComplete="off"
            helpText="Add a line break to include phone, email, or any contact info below the message." />
        </BlockStack>
      )}
      {statusTab === "login" && (
        <BlockStack gap="300">
          <TextField label="Title" value={settings.loginTitle} onChange={(v) => set("loginTitle", v)} autoComplete="off" />
          <TextField label="Message" value={settings.loginMessage} onChange={(v) => set("loginMessage", v)} multiline={4} autoComplete="off"
            helpText="Shown to customers who must log in before submitting the form." />
        </BlockStack>
      )}

      {/* Page management — only shown once a page is published */}
      {shopifyPageId && (
        <>
          <Divider />
          <BlockStack gap="200">
            <a
              href={pageUrl} target="_blank" rel="noreferrer"
              style={{
                display: "block", padding: "9px 14px",
                background: "#f8fafc", border: "1px solid #e5e7eb",
                borderRadius: 8, color: "#0f172a", fontSize: 13,
                fontWeight: 500, textDecoration: "none", textAlign: "center",
              }}
            >
              View published page ↗
            </a>
            <Button tone="critical" onClick={onDisconnect}>Delete page</Button>
            <Text as="p" variant="bodySm" tone="subdued">
              Deletes the Shopify page and unlocks the handle so you can republish with a new URL.
            </Text>
          </BlockStack>
        </>
      )}
    </BlockStack>
  );
}

function AppearancePanel({ appearance, setAppearance }: {
  appearance: AppearanceSettings;
  setAppearance: React.Dispatch<React.SetStateAction<AppearanceSettings>>;
}) {
  const set = <K extends keyof AppearanceSettings>(k: K, v: AppearanceSettings[K]) =>
    setAppearance((p) => ({ ...p, [k]: v }));
  return (
    <BlockStack gap="400">
      <InlineStack gap="300">
        <div style={{ flex: 1 }}>
          <TextField label="Form width (px)" type="number" value={appearance.formWidth} onChange={(v) => set("formWidth", v)} autoComplete="off" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label="Font size (px)" type="number" value={appearance.fontSize} onChange={(v) => set("fontSize", v)} autoComplete="off" />
        </div>
      </InlineStack>
      <Select label="Font weight" options={FONT_WEIGHTS} value={appearance.fontWeight} onChange={(v) => set("fontWeight", v)} />
      <Divider />
      {([
        ["headingColor", "Heading color"],
        ["labelColor", "Label color"],
        ["inputFieldColor", "Input text color"],
        ["primaryButtonColor", "Primary button color"],
        ["secondaryButtonColor", "Button text color"],
        ["backgroundColor", "Background color"],
      ] as const).map(([key, label]) => (
        <ColorRow key={key} label={label} value={appearance[key]} onChange={(v) => set(key, v)} />
      ))}
    </BlockStack>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <InlineStack gap="200" blockAlign="center">
      <div style={{ flex: 1 }}>
        <TextField label={label} value={value} onChange={onChange} autoComplete="off"
          prefix={<div style={{ width: 14, height: 14, borderRadius: 3, background: value, border: "1px solid #c9cccf" }} />} />
      </div>
      <div style={{ paddingTop: 22 }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={{ width: 34, height: 34, padding: 2, border: "none", cursor: "pointer", borderRadius: 5 }} />
      </div>
    </InlineStack>
  );
}

function OptionsEditor({ options, onChange }: { options: string[]; onChange: (opts: string[]) => void }) {
  return (
    <FormLayout>
      {options.map((opt, i) => (
        <InlineStack key={i} gap="200" blockAlign="center">
          <div style={{ flex: 1 }}>
            <TextField label="" labelHidden value={opt}
              onChange={(v) => { const n = [...options]; n[i] = v; onChange(n); }}
              autoComplete="off" prefix={`${i + 1}.`} />
          </div>
          <Button size="slim" tone="critical" disabled={options.length <= 1}
            onClick={() => onChange(options.filter((_, j) => j !== i))}>✕</Button>
        </InlineStack>
      ))}
      <Button size="slim" onClick={() => onChange([...options, `Option ${options.length + 1}`])}>+ Add option</Button>
    </FormLayout>
  );
}

// ─── Preview HTML helpers (client-side) ──────────────────────────────────────

function escHtmlClient(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderPreviewField(f: FormField): string {
  const req = f.required ? `<span class="req">*</span>` : "";
  const id = `field_${f.id}`;
  const labelHtml = !f.hideLabel ? `<label for="${id}">${escHtmlClient(f.label)}${req}</label>` : "";
  const descHtml = f.description ? `<div class="desc">${escHtmlClient(f.description)}</div>` : "";
  const t = f.type;
  let input = "";
  if (t === "text" || t === "email" || t === "tel" || t === "number") {
    input = `<input type="${t}" id="${id}" name="${id}" placeholder="${escHtmlClient(f.placeholder || "")}">`;
  } else if (t === "textarea") {
    input = `<textarea id="${id}" name="${id}" placeholder="${escHtmlClient(f.placeholder || "")}"></textarea>`;
  } else if (t === "select") {
    const opts = f.options.map((o) => `<option value="${escHtmlClient(o)}">${escHtmlClient(o)}</option>`).join("");
    input = `<select id="${id}" name="${id}"><option value="">— select —</option>${opts}</select>`;
  } else if (t === "radio") {
    const opts = f.options.map((o) =>
      `<label class="inline-opt"><input type="radio" name="${id}" value="${escHtmlClient(o)}"> ${escHtmlClient(o)}</label>`
    ).join("");
    input = `<div class="radio-group">${opts}</div>`;
  } else if (t === "checkbox") {
    input = `<label class="inline-opt"><input type="checkbox" name="${id}" value="yes"> ${escHtmlClient(f.label)}</label>`;
  } else if (t === "terms") {
    input = `<label class="inline-opt terms-text"><input type="checkbox" name="${id}" value="yes"> ${escHtmlClient(f.content || f.label)}</label>`;
  } else if (t === "file") {
    input = `<input type="file" id="${id}" name="${id}">`;
  }
  return `<div class="field">${labelHtml}${input}${descHtml}</div>`;
}

function buildPreviewHtml(rows: FormRow[], settings: GlobalSettings, appearance: AppearanceSettings): string {
  const bg  = appearance.backgroundColor;
  const w   = parseInt(appearance.formWidth) || 600;
  const fs  = parseInt(appearance.fontSize) || 14;
  const fw  = appearance.fontWeight;
  const hc  = appearance.headingColor;
  const lc  = appearance.labelColor;
  const ic  = appearance.inputFieldColor;
  const pc  = appearance.primaryButtonColor;
  const sc  = appearance.secondaryButtonColor;

  const rowsHtml = rows.map((row) => {
    const cols = row.fields.length || 1;
    const fieldsHtml = row.fields.map((f) => renderPreviewField(f)).join("");
    return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:16px;margin-bottom:16px">${fieldsHtml}</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:${fs}px;font-weight:${fw};color:${lc};padding:44px 20px 80px;line-height:1.6;-webkit-font-smoothing:antialiased;}
.wrap{max-width:${w}px;margin:0 auto}
.form-card{background:${bg};border-radius:20px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 16px rgba(0,0,0,0.06),0 24px 34px rgba(0,0,0,0.07);}
.form-card-body{padding:40px 44px 48px}
.form-eyebrow{display:inline-flex;align-items:center;gap:7px;background:${pc}15;color:${pc};border-radius:100px;padding:4px 13px 4px 9px;font-size:.7em;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:16px;}
.form-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:${pc};flex-shrink:0;display:inline-block}
h2{color:${hc};font-size:2em;font-weight:800;letter-spacing:-0.04em;line-height:1.1;margin-bottom:10px}
.form-sub{color:#6b7280;font-size:.9375em;line-height:1.55;margin-bottom:32px;padding-bottom:28px;border-bottom:1.5px solid ${pc}25;}
.field{display:flex;flex-direction:column;gap:6px}
label{display:block;font-size:.8125em;font-weight:600;color:${lc};letter-spacing:.01em}
label .req{color:#ef4444;margin-left:2px}
.desc{font-size:.8em;color:#9ca3af;line-height:1.4;margin-top:-2px}
input,select,textarea{width:100%;padding:11px 16px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:${fs}px;font-family:inherit;color:${ic};background:#fafafa;outline:none;transition:all .18s;-webkit-appearance:none;}
input:focus,select:focus,textarea:focus{border-color:${pc};background:#fff;box-shadow:0 0 0 4px ${pc}15;}
textarea{resize:vertical;min-height:96px}
.radio-group{display:flex;flex-direction:column;gap:10px;padding-top:3px}
.inline-opt{display:flex;align-items:flex-start;gap:10px;font-weight:400;cursor:pointer;line-height:1.55}
.inline-opt input{margin-top:3px;accent-color:${pc};flex-shrink:0;width:16px;height:16px}
.terms-text{font-size:.86em;line-height:1.7;color:#6b7280}
.form-footer{margin-top:28px;padding-top:24px;border-top:1px solid #f3f4f6}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 28px;background:${pc};color:${sc};border:none;border-radius:12px;font-size:${fs}px;font-family:inherit;font-weight:700;cursor:pointer;width:100%;letter-spacing:.01em;box-shadow:0 2px 8px ${pc}30;transition:all .15s;}
.btn-arrow{display:inline-block;transition:transform .15s}
.btn:hover{filter:brightness(1.08);box-shadow:0 6px 24px ${pc}40;transform:translateY(-1px)}
.btn:hover .btn-arrow{transform:translateX(3px)}
.btn:active{transform:translateY(0)}
</style>
</head>
<body>
<div class="wrap">
<div class="form-card">
  <div class="form-card-accent"></div>
  <div class="form-card-body">
    ${settings.formName ? `<h2>${escHtmlClient(settings.formName)}</h2>` : ""}
    ${settings.formSubtitle ? `<p class="form-sub">${escHtmlClient(settings.formSubtitle)}</p>` : ""}
    <form onsubmit="return false">
${rowsHtml}
      <div class="form-footer">
        <button type="button" class="btn">${escHtmlClient(settings.ctaButtonText || "Submit Application")}<span class="btn-arrow">→</span></button>
      </div>
    </form>
  </div>
</div>
</div>
</body>
</html>`;
}
