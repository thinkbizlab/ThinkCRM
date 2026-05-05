-- Co-Visit feature: supervisors / managers / directors / assistant managers /
-- sales admins join a rep's existing Visit to evaluate the rep in the field.
-- Multiple co-visitors per visit; each performs their own check-in/out and
-- writes their own evaluation. Eval is hidden from the rep until released.
--
-- Three new tables + one new flag on TenantVisitConfig.

ALTER TABLE "TenantVisitConfig"
  ADD COLUMN "coVisitCountsAsRepVisit" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "VisitCoVisitor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "coVisitorUserId" TEXT NOT NULL,
    "checkInAt" TIMESTAMP(3),
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkInDistanceM" DOUBLE PRECISION,
    "checkInSelfie" TEXT,
    "checkOutAt" TIMESTAMP(3),
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "evalScore" INTEGER,
    "evalNotes" TEXT,
    "evalReleasedAt" TIMESTAMP(3),
    "evalReleasedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitCoVisitor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VisitCoVisitor_visitId_coVisitorUserId_key"
  ON "VisitCoVisitor"("visitId", "coVisitorUserId");
CREATE INDEX "VisitCoVisitor_tenantId_coVisitorUserId_checkInAt_idx"
  ON "VisitCoVisitor"("tenantId", "coVisitorUserId", "checkInAt");
CREATE INDEX "VisitCoVisitor_tenantId_coVisitorUserId_evalReleasedAt_idx"
  ON "VisitCoVisitor"("tenantId", "coVisitorUserId", "evalReleasedAt");

ALTER TABLE "VisitCoVisitor" ADD CONSTRAINT "VisitCoVisitor_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisitCoVisitor" ADD CONSTRAINT "VisitCoVisitor_visitId_fkey"
  FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisitCoVisitor" ADD CONSTRAINT "VisitCoVisitor_coVisitorUserId_fkey"
  FOREIGN KEY ("coVisitorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VisitCoVisitor" ADD CONSTRAINT "VisitCoVisitor_evalReleasedByUserId_fkey"
  FOREIGN KEY ("evalReleasedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CompetencyTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetencyTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompetencyTemplate_tenantId_code_key"
  ON "CompetencyTemplate"("tenantId", "code");
CREATE INDEX "CompetencyTemplate_tenantId_isActive_sortOrder_idx"
  ON "CompetencyTemplate"("tenantId", "isActive", "sortOrder");

ALTER TABLE "CompetencyTemplate" ADD CONSTRAINT "CompetencyTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VisitCoVisitorCompetencyScore" (
    "id" TEXT NOT NULL,
    "visitCoVisitorId" TEXT NOT NULL,
    "competencyTemplateId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitCoVisitorCompetencyScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VisitCoVisitorCompetencyScore_visitCoVisitorId_competencyTemplateId_key"
  ON "VisitCoVisitorCompetencyScore"("visitCoVisitorId", "competencyTemplateId");

ALTER TABLE "VisitCoVisitorCompetencyScore" ADD CONSTRAINT "VisitCoVisitorCompetencyScore_visitCoVisitorId_fkey"
  FOREIGN KEY ("visitCoVisitorId") REFERENCES "VisitCoVisitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisitCoVisitorCompetencyScore" ADD CONSTRAINT "VisitCoVisitorCompetencyScore_competencyTemplateId_fkey"
  FOREIGN KEY ("competencyTemplateId") REFERENCES "CompetencyTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
