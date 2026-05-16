-- Extend isDemo flag to additional top-level entities for richer demo-data generation.
-- Child entities (CustomerAddress, QuotationItem, DealProgressUpdate, VisitCoVisitor,
-- ProspectPhoto, SalesKpiTarget, Quotation) inherit demo status through their FK parents.

ALTER TABLE "CustomerGroup" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Item"          ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Prospect"      ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Announcement"  ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
