-- Drop the Customer.defaultTermId column and its FK to PaymentTerm.
-- PaymentTerm itself is kept (Quotation.paymentTermId still uses it).
-- Quotation.paymentTermId never auto-derived from Customer.defaultTermId,
-- so removing this changes no downstream behavior.

ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_defaultTermId_fkey";
ALTER TABLE "Customer" DROP COLUMN IF EXISTS "defaultTermId";
