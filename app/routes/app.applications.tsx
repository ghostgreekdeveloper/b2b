// app/routes/applications.tsx
import {
  IndexTable,
  LegacyCard,
  LegacyTabs,
  IndexFilters,
  useSetIndexFiltersMode,
  useIndexResourceState,
  Badge,
  useBreakpoints,
  ButtonGroup,
  Button,
  Page,
  Link,
  Text,
  TextField,
  BlockStack,
  Divider,
  Banner,
} from "@shopify/polaris";
import type { IndexFiltersProps, TabProps } from "@shopify/polaris";
import { useState, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import type { LoaderArgs, ActionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { refreshAllAcceptedCustomerMetafields } from "../writeCustomerMetafield.server";

// Loader: fetch customers and form status — scoped to this store only
export const loader = async ({ request }: LoaderArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [customers, form] = await Promise.all([
    db.customers.findMany({
      where: { shopDomain: shop, applicationStatus: { not: "ACCEPTED" } },
      select: {
        id: true, firstName: true, lastName: true, email: true,
        applicationDate: true, businessName: true, taxId: true, applicationStatus: true,
      },
    }),
    db.form.findFirst({ where: { shopDomain: shop }, select: { id: true, status: true, minimumOrderCents: true } }),
  ]);

  return json({ customers, form });
};

export const action = async ({ request }: ActionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent")?.toString() ?? "toggle";

  // Upsert so every store gets their own Form row automatically
  const dbForm = await db.form.upsert({
    where: { shopDomain: shop },
    update: {},
    create: { shopDomain: shop, status: true },
    select: { id: true, status: true },
  });

  if (intent === "save-settings") {
    const minimumAmountStr = formData.get("minimumOrderAmount")?.toString() ?? "";
    const parsedMinimum = parseFloat(minimumAmountStr);
    const minimumOrderCents =
      minimumAmountStr === "" || isNaN(parsedMinimum) || parsedMinimum <= 0
        ? null
        : Math.round(parsedMinimum * 100);

    await db.form.update({ where: { id: dbForm.id }, data: { minimumOrderCents } });
    refreshAllAcceptedCustomerMetafields(admin, shop);
    return json({ success: true, savedMinimum: true });
  }

  const updatedForm = await db.form.update({
    where: { id: dbForm.id },
    data: { status: !dbForm.status },
  });
  return json({ status: updatedForm.status });
};

export default function ApplicationsPage() {
  const { customers, form } = useLoaderData<{ customers: any[]; form: any }>();
  const navigate = useNavigate();
  const [formStatus, setFormStatus] = useState(form?.status ?? false);
  const [minimumOrderAmount, setMinimumOrderAmount] = useState(
    form?.minimumOrderCents ? String((form.minimumOrderCents / 100).toFixed(2)) : ""
  );
  const fetcher = useFetcher<{ success?: boolean; savedMinimum?: boolean; status?: boolean }>();
  const settingsSaved = fetcher.data?.savedMinimum === true;

  const formButtonText = formStatus ? "Turn form off" : "Turn form on";

  // 🔹 Top-level tabs (Submissions / Form Settings)
  const [mainTab, setMainTab] = useState(0);
  const handleMainTabChange = useCallback(
    (selectedTabIndex: number) => setMainTab(selectedTabIndex),
    []
  );

  const mainTabs = [
    { id: "submissions", content: "Submissions", panelID: "submissions-panel" },
    { id: "form-settings", content: "Form settings", panelID: "settings-panel" },
  ];

  // Sub-tabs inside submissions
  const tabsList = ["Pending", "Rejected"];
  const [selectedTab, setSelectedTab] = useState(0);
  const [sortSelected, setSortSelected] = useState(["name asc"]);
  const [queryValue, setQueryValue] = useState("");
  const { mode, setMode } = useSetIndexFiltersMode();
  const breakpoints = useBreakpoints();

  const applications = customers.map((c) => ({
    id: c.id,
    name: c.firstName || c.lastName ? `${c.firstName || ""} ${c.lastName || ""}`.trim() : "None",
    date: c.applicationDate ? new Date(c.applicationDate).toLocaleString() : "None",
    company: c.businessName || "None",
    status: c.applicationStatus?.toUpperCase() || "PENDING",
  }));

  const tabs: TabProps[] = tabsList.map((item, index) => ({
    content: item,
    index,
    id: `${item}-${index}`,
    isLocked: true,
  }));

  const sortOptions: IndexFiltersProps["sortOptions"] = [
    { label: "Name", value: "name asc", directionLabel: "A-Z" },
    { label: "Name", value: "name desc", directionLabel: "Z-A" },
    { label: "Company", value: "company asc", directionLabel: "A-Z" },
    { label: "Company", value: "company desc", directionLabel: "Z-A" },
    { label: "Date", value: "date asc", directionLabel: "Oldest to newest" },
    { label: "Date", value: "date desc", directionLabel: "Newest to oldest" },
  ];

  const filteredApplications = applications
    .filter((app) => app.status === tabsList[selectedTab].toUpperCase())
    .filter((app) =>
      queryValue
        ? app.name.toLowerCase().includes(queryValue.toLowerCase()) ||
          app.company.toLowerCase().includes(queryValue.toLowerCase())
        : true
    )
    .sort((a, b) => {
      const [field, direction] = sortSelected[0].split(" ");
      const dir = direction === "asc" ? 1 : -1;
      if (field === "name") return a.name.localeCompare(b.name) * dir;
      if (field === "company") return a.company.localeCompare(b.company) * dir;
      if (field === "date") {
        const da = a.date === "None" ? 0 : new Date(a.date).getTime();
        const db = b.date === "None" ? 0 : new Date(b.date).getTime();
        return (da - db) * dir;
      }
      return 0;
    });

  const resourceName = { singular: "application", plural: "applications" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(filteredApplications);

  const rowMarkup = filteredApplications.map(
    ({ id, name, company, date, status }, index) => {
      let badgeStatus: "attention" | "critical" | "success" | "info" = "info";
      if (status === "REJECTED") badgeStatus = "critical";
      else if (status === "ACCEPTED") badgeStatus = "success";

      const url = `/app/customer/${id}`;

      return (
        <IndexTable.Row
          id={id}
          key={id}
          selected={selectedResources.includes(id)}
          position={index}
        >
          <IndexTable.Cell>
            <Link dataPrimaryLink url={url}>
              <Text fontWeight="bold" as="span">
                {name}
              </Text>
            </Link>
          </IndexTable.Cell>
          <IndexTable.Cell>{date}</IndexTable.Cell>
          <IndexTable.Cell>{company}</IndexTable.Cell>
          <IndexTable.Cell>
            <Badge tone={badgeStatus}>{status}</Badge>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }
  );

  const totalCount    = customers.length;
  const pendingCount  = customers.filter((c) => c.applicationStatus === "PENDING").length;
  const rejectedCount = customers.filter((c) => c.applicationStatus === "REJECTED").length;

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
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "3px 12px", marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Wholesale applications</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 750, color: "#f8fafc", letterSpacing: "-0.03em" }}>Applications</h1>
              <button
                onClick={() => navigate("/app/form-builder")}
                style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#f1f5f9", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: "0.02em" }}
              >
                Build Form
              </button>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 480 }}>
            {[
              { label: "Total",    value: totalCount,    icon: "◎" },
              { label: "Pending",  value: pendingCount,  icon: "◷" },
              { label: "Rejected", value: rejectedCount, icon: "✕" },
            ].map((s) => (
              <div key={s.label} style={{ background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, padding: "14px 16px" }}>
                <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>{s.icon} {s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 750, color: "#f1f5f9", letterSpacing: "-0.02em" }}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

    <LegacyCard sectioned>
      <LegacyTabs tabs={mainTabs} selected={mainTab} onSelect={handleMainTabChange}>
        {mainTab === 0 && (
          <LegacyCard.Section>
            <IndexFilters
              sortOptions={sortOptions}
              sortSelected={sortSelected}
              queryValue={queryValue}
              queryPlaceholder="Search applications"
              onQueryChange={setQueryValue}
              onQueryClear={() => setQueryValue("")}
              onSort={setSortSelected}
              tabs={tabs}
              selected={selectedTab}
              onSelect={setSelectedTab}
              mode={mode}
              setMode={setMode}
              disableCreate
              filters={[]}
              appliedFilters={[]}
            />
            <IndexTable
              condensed={breakpoints.smDown}
              resourceName={resourceName}
              itemCount={filteredApplications.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Name" },
                { title: "Date" },
                { title: "Company" },
                { title: "Status" },
              ]}
            >
              {rowMarkup}
            </IndexTable>
          </LegacyCard.Section>
        )}

        {mainTab === 1 && (
          <LegacyCard.Section>
            <BlockStack gap="500">
              {settingsSaved && (
                <Banner tone="success">
                  Global minimum saved and pushed to all approved wholesale customers.
                </Banner>
              )}

              {/* Application form toggle */}
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Application form</Text>
                <Text as="p" tone="subdued">
                  When off, new customers cannot submit wholesale applications.
                </Text>
                <ButtonGroup>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="toggle" />
                    <Button submit onClick={() => setFormStatus(!formStatus)}>
                      {formButtonText}
                    </Button>
                  </fetcher.Form>
                  <Button variant="primary" onClick={() => navigate("/app/form-builder")}>
                    Edit Form
                  </Button>
                </ButtonGroup>
              </BlockStack>

              <Divider />

              {/* Global minimum order */}
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Global minimum order amount</Text>
                <Text as="p" tone="subdued">
                  Applies to all approved wholesale customers as a floor. Per-customer
                  minimums (set on the customer page) override this if they are higher.
                  Changing this immediately updates all customers&apos; checkout validation.
                </Text>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="save-settings" />
                  <BlockStack gap="400">
                    <TextField
                      label="Minimum order amount"
                      type="number"
                      name="minimumOrderAmount"
                      value={minimumOrderAmount}
                      onChange={setMinimumOrderAmount}
                      autoComplete="off"
                      prefix="€"
                      helpText="Leave empty to remove the global minimum."
                    />
                    <Button
                      submit
                      variant="primary"
                      loading={fetcher.state === "submitting"}
                    >
                      Save &amp; apply to all customers
                    </Button>
                  </BlockStack>
                </fetcher.Form>
              </BlockStack>
            </BlockStack>
          </LegacyCard.Section>
        )}
      </LegacyTabs>
    </LegacyCard>
    </BlockStack>
    </Page>
  );
}
