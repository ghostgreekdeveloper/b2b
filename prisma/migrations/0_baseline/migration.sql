-- PostgreSQL baseline migration (full schema)

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'REJECTED', 'ACCEPTED');

-- CreateTable: Form
CREATE TABLE "Form" (
    "id"                     SERIAL NOT NULL,
    "shopDomain"             TEXT NOT NULL DEFAULT '',
    "status"                 BOOLEAN NOT NULL DEFAULT true,
    "minimumOrderCents"      INTEGER,
    "formFields"             TEXT NOT NULL DEFAULT '[]',
    "urlHandle"              TEXT NOT NULL DEFAULT 'register-wholesale',
    "ctaButtonText"          TEXT NOT NULL DEFAULT 'Submit Application',
    "approvalMode"           TEXT NOT NULL DEFAULT 'MANUAL',
    "autoTag"                TEXT NOT NULL DEFAULT '',
    "autoExemptTax"          BOOLEAN NOT NULL DEFAULT false,
    "formName"               TEXT NOT NULL DEFAULT 'Wholesale Registration Form',
    "submissionMessage"      TEXT NOT NULL DEFAULT 'Your application has been submitted!',
    "pendingTitle"           TEXT NOT NULL DEFAULT 'Application Under Review',
    "pendingMessage"         TEXT NOT NULL DEFAULT 'We''ve received your application and our team will review it shortly. We''ll be in touch soon!',
    "acceptedTitle"          TEXT NOT NULL DEFAULT 'Wholesale Account Active',
    "acceptedMessage"        TEXT NOT NULL DEFAULT 'Your wholesale account is approved and active. Enjoy your exclusive pricing and access!',
    "rejectedTitle"          TEXT NOT NULL DEFAULT 'Application Not Approved',
    "rejectedMessage"        TEXT NOT NULL DEFAULT 'Unfortunately your application wasn''t approved at this time. Please contact us if you have any questions.',
    "loginTitle"             TEXT NOT NULL DEFAULT 'Login Required',
    "loginMessage"           TEXT NOT NULL DEFAULT 'Please log in to your account to submit a wholesale application.',
    "formWidth"              INTEGER NOT NULL DEFAULT 600,
    "fontSize"               INTEGER NOT NULL DEFAULT 14,
    "fontWeight"             TEXT NOT NULL DEFAULT 'Medium',
    "headingColor"           TEXT NOT NULL DEFAULT '#303030',
    "labelColor"             TEXT NOT NULL DEFAULT '#303030',
    "inputFieldColor"        TEXT NOT NULL DEFAULT '#303030',
    "primaryButtonColor"     TEXT NOT NULL DEFAULT '#303030',
    "secondaryButtonColor"   TEXT NOT NULL DEFAULT '#FFFFFF',
    "backgroundColor"        TEXT NOT NULL DEFAULT '#FFFFFF',
    "shopifyPageId"          TEXT,
    "resendApiKey"           TEXT,
    "adminNotificationEmail" TEXT,
    "emailsSentMonth"        INTEGER NOT NULL DEFAULT 0,
    "emailsMonthKey"         TEXT NOT NULL DEFAULT '',
    "emailFromName"          TEXT NOT NULL DEFAULT 'B2B Wholesale',
    "emailFromAddress"       TEXT NOT NULL DEFAULT '',
    "emailAccentColor"       TEXT NOT NULL DEFAULT '#303030',
    "emailAdminSubject"      TEXT NOT NULL DEFAULT 'New wholesale application',
    "emailPendingEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "emailPendingSubject"    TEXT NOT NULL DEFAULT 'We received your application',
    "emailPendingBody"       TEXT NOT NULL DEFAULT 'Thank you for applying! Our team will review your application and get back to you shortly.',
    "emailApprovedSubject"   TEXT NOT NULL DEFAULT 'Your wholesale application has been approved',
    "emailApprovedBody"      TEXT NOT NULL DEFAULT 'Congratulations! Your wholesale account is now active. You can now log in and access your exclusive wholesale pricing.',
    "emailRejectedSubject"   TEXT NOT NULL DEFAULT 'Update on your wholesale application',
    "emailRejectedBody"      TEXT NOT NULL DEFAULT 'Thank you for your interest in our wholesale program. Unfortunately, we''re unable to approve your application at this time. Please don''t hesitate to contact us if you have any questions.',
    "emailAdminBlocks"       TEXT NOT NULL DEFAULT '[]',
    "emailPendingBlocks"     TEXT NOT NULL DEFAULT '[]',
    "emailApprovedBlocks"    TEXT NOT NULL DEFAULT '[]',
    "emailRejectedBlocks"    TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Catalog
CREATE TABLE "Catalog" (
    "id"                     SERIAL NOT NULL,
    "shopDomain"             TEXT NOT NULL,
    "title"                  TEXT NOT NULL,
    "tag"                    TEXT NOT NULL,
    "status"                 TEXT NOT NULL DEFAULT 'active',
    "segmentId"              TEXT,
    "defaultDiscountPercent" DOUBLE PRECISION,
    "discountTitle"          TEXT,
    "minimumOrderMessage"    TEXT,
    "autoIncludeProducts"    BOOLEAN NOT NULL DEFAULT true,
    "discountType"           TEXT NOT NULL DEFAULT 'PERCENT',
    "fixedDiscountCents"     INTEGER,
    "fixedPriceCents"        INTEGER,
    "priceDisplay"           TEXT NOT NULL DEFAULT 'REPLACED',
    "cacheVersion"           INTEGER NOT NULL DEFAULT 1,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CatalogItem
CREATE TABLE "CatalogItem" (
    "id"                    SERIAL NOT NULL,
    "catalogId"             INTEGER NOT NULL,
    "productId"             TEXT NOT NULL,
    "variantId"             TEXT,
    "name"                  TEXT,
    "sku"                   TEXT,
    "img"                   TEXT,
    "customPriceCents"      BIGINT,
    "customDiscountPercent" BIGINT,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: segments
CREATE TABLE "segments" (
    "id"                TEXT NOT NULL,
    "shopDomain"        TEXT NOT NULL DEFAULT '',
    "title"             TEXT NOT NULL,
    "customercondition" TEXT NOT NULL,
    "catalog"           TEXT,
    "status"            TEXT NOT NULL DEFAULT 'Draft',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "shopifySegmentId"  TEXT,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: segment_items
CREATE TABLE "segment_items" (
    "id"        TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "priceCents" BIGINT,
    "discount"  DOUBLE PRECISION,

    CONSTRAINT "segment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable: VariantPrice
CREATE TABLE "VariantPrice" (
    "variantId"           BIGINT NOT NULL,
    "shopDomain"          TEXT NOT NULL,
    "productId"           TEXT NOT NULL,
    "sku"                 TEXT,
    "priceCents"          INTEGER NOT NULL,
    "compareAtPriceCents" INTEGER,
    "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantPrice_pkey" PRIMARY KEY ("variantId")
);

-- CreateTable: Customers
CREATE TABLE "Customers" (
    "id"                TEXT NOT NULL,
    "shopDomain"        TEXT NOT NULL DEFAULT '',
    "firstName"         TEXT,
    "lastName"          TEXT,
    "email"             TEXT,
    "applicationDate"   TIMESTAMP(3),
    "businessName"      TEXT,
    "taxId"             TEXT,
    "applicationStatus" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "catalogId"         INTEGER,
    "phone"             TEXT,
    "shippingAddressId" INTEGER,
    "billingAddressId"  INTEGER,
    "minimumOrderCents" INTEGER,
    "formResponses"     TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "Customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Address
CREATE TABLE "Address" (
    "id"       SERIAL NOT NULL,
    "street"   TEXT,
    "address2" TEXT,
    "city"     TEXT NOT NULL,
    "province" TEXT,
    "zip"      TEXT NOT NULL,
    "country"  TEXT NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable: customer_catalogs
CREATE TABLE "customer_catalogs" (
    "customerId" TEXT NOT NULL,
    "catalogId"  INTEGER NOT NULL,

    CONSTRAINT "customer_catalogs_pkey" PRIMARY KEY ("customerId","catalogId")
);

-- CreateTable: WebhookEvent
CREATE TABLE "WebhookEvent" (
    "id"          SERIAL NOT NULL,
    "webhookId"   TEXT NOT NULL,
    "shop"        TEXT NOT NULL,
    "topic"       TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Session
CREATE TABLE "Session" (
    "id"            TEXT NOT NULL,
    "shop"          TEXT NOT NULL,
    "state"         TEXT NOT NULL,
    "isOnline"      BOOLEAN NOT NULL DEFAULT false,
    "scope"         TEXT,
    "expires"       TIMESTAMP(3),
    "accessToken"   TEXT NOT NULL,
    "userId"        BIGINT,
    "firstName"     TEXT,
    "lastName"      TEXT,
    "email"         TEXT,
    "accountOwner"  BOOLEAN NOT NULL DEFAULT false,
    "locale"        TEXT,
    "collaborator"  BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- Unique indexes
CREATE UNIQUE INDEX "Form_shopDomain_key" ON "Form"("shopDomain");
CREATE UNIQUE INDEX "Catalog_title_key" ON "Catalog"("title");
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- Regular indexes
CREATE INDEX "CatalogItem_catalogId_idx" ON "CatalogItem"("catalogId");
CREATE INDEX "CatalogItem_catalogId_variantId_idx" ON "CatalogItem"("catalogId", "variantId");
CREATE INDEX "segments_shopDomain_idx" ON "segments"("shopDomain");
CREATE INDEX "Customers_shopDomain_catalogId_applicationStatus_idx" ON "Customers"("shopDomain", "catalogId", "applicationStatus");
CREATE INDEX "Customers_shopDomain_applicationStatus_idx" ON "Customers"("shopDomain", "applicationStatus");
CREATE INDEX "WebhookEvent_shop_idx" ON "WebhookEvent"("shop");
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- Foreign keys
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "segment_items" ADD CONSTRAINT "segment_items_segmentId_fkey"
    FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Customers" ADD CONSTRAINT "Customers_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Customers" ADD CONSTRAINT "Customers_shippingAddressId_fkey"
    FOREIGN KEY ("shippingAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Customers" ADD CONSTRAINT "Customers_billingAddressId_fkey"
    FOREIGN KEY ("billingAddressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;
