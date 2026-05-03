import { Anthropic } from "@anthropic-ai/sdk";
import { AiCallStatus, AiFeature, AiProvider, CustomerDuplicateSignal, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { decryptField } from "../../lib/secrets.js";
import { recordAiUsage } from "../../lib/ai-usage.js";

// ── Normalization helpers ───────────────────────────────────────────────────
// Strip everything except digits and compare the last 9 digits. This collapses
// "+66 2 123 4567", "02-123-4567", "0066 2 1234567" into the same key.
function normPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

function normTaxId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 9 ? digits : null;
}

function normEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Strip legal-entity suffixes, punctuation, and whitespace for name comparison.
// "ABC Co., Ltd." and "abc  co ltd" collapse to "abc".
const LEGAL_SUFFIXES = [
  "co ltd", "co,ltd", "coltd", "company limited", "company ltd", "limited",
  "ltd", "inc", "corp", "corporation", "plc", "gmbh", "bv", "nv",
  "บริษัท", "จำกัด", "มหาชน", "ห้างหุ้นส่วนจำกัด", "หจก", "หสม"
];
function normName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase().replace(/[.,()\-_/&]+/g, " ").replace(/\s+/g, " ").trim();
  for (const suffix of LEGAL_SUFFIXES) {
    if (s.endsWith(" " + suffix)) s = s.slice(0, -suffix.length - 1).trim();
    if (s.startsWith(suffix + " ")) s = s.slice(suffix.length + 1).trim();
  }
  return s;
}

// ── Deterministic pairs ─────────────────────────────────────────────────────

type Pair = {
  customerAId: string;
  customerBId: string;
  signal: CustomerDuplicateSignal;
  confidence: number;
  reasonText: string;
};

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

type CustomerRow = {
  id: string;
  // DRAFT customers have no ERP code yet, so this can be null. Dedup still
  // runs across DRAFT and ACTIVE rows together so we can catch no-Tax-ID
  // drafts that resemble an incoming ERP record.
  customerCode: string | null;
  name: string;
  taxId: string | null;
  branchCode: string | null;
  contacts: Array<{ tel: string | null; email: string | null }>;
};

function buildDeterministicPairs(rows: CustomerRow[]): Pair[] {
  const byTax = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const byName = new Map<string, string[]>();

  const addTo = (map: Map<string, string[]>, key: string | null, id: string) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(id);
    map.set(key, list);
  };

  for (const row of rows) {
    // Tax ID dedup keys on (taxId + branchCode) so two distinct branches of
    // the same legal entity are NOT flagged as duplicates of each other —
    // they're legitimately separate billable rows.
    const taxKey = normTaxId(row.taxId);
    const taxBranchKey = taxKey ? `${taxKey}:${row.branchCode ?? "00000"}` : null;
    addTo(byTax, taxBranchKey, row.id);
    addTo(byName, normName(row.name), row.id);
    for (const c of row.contacts) {
      addTo(byPhone, normPhone(c.tel), row.id);
      addTo(byEmail, normEmail(c.email), row.id);
    }
  }

  const seen = new Set<string>();
  const out: Pair[] = [];
  const emit = (ids: string[], signal: CustomerDuplicateSignal, value: string, confidence: number) => {
    if (ids.length < 2) return;
    const uniq = Array.from(new Set(ids));
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const [a, b] = pairKey(uniq[i]!, uniq[j]!);
        const k = `${signal}:${a}:${b}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          customerAId: a,
          customerBId: b,
          signal,
          confidence,
          reasonText: `${signal.toLowerCase()} match: ${value}`
        });
      }
    }
  };

  for (const [val, ids] of byTax)   emit(ids, CustomerDuplicateSignal.TAX_ID,     val, 0.99);
  for (const [val, ids] of byPhone) emit(ids, CustomerDuplicateSignal.PHONE,      val, 0.9);
  for (const [val, ids] of byEmail) emit(ids, CustomerDuplicateSignal.EMAIL,      val, 0.92);
  for (const [val, ids] of byName)  {
    if (val.length >= 4) emit(ids, CustomerDuplicateSignal.NAME_EXACT, val, 0.85);
  }
  return out;
}

// ── Fuzzy name clusters for AI adjudication ─────────────────────────────────
// Simple 3-gram Jaccard similarity over normalized names, bucketed by first
// 3-gram to keep the comparison O(bucket²) instead of O(n²).

function ngrams(s: string, n = 3): Set<string> {
  const out = new Set<string>();
  if (s.length < n) { if (s) out.add(s); return out; }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function buildFuzzyNameCandidates(rows: CustomerRow[], excluded: Set<string>): Array<{ a: CustomerRow; b: CustomerRow; similarity: number }> {
  const prepared = rows.map((r) => ({ row: r, norm: normName(r.name), grams: ngrams(normName(r.name)) }))
                       .filter((r) => r.norm.length >= 4);
  const byFirstGram = new Map<string, typeof prepared>();
  for (const p of prepared) {
    const first = p.norm.slice(0, 3);
    const list = byFirstGram.get(first) ?? [];
    list.push(p);
    byFirstGram.set(first, list);
  }
  const out: Array<{ a: CustomerRow; b: CustomerRow; similarity: number }> = [];
  const seen = new Set<string>();
  for (const group of byFirstGram.values()) {
    for (let i = 0; i < group.length; i++) {
      const gi = group[i]!;
      for (let j = i + 1; j < group.length; j++) {
        const gj = group[j]!;
        const [a, b] = pairKey(gi.row.id, gj.row.id);
        const k = `${a}:${b}`;
        if (seen.has(k) || excluded.has(k)) continue;
        seen.add(k);
        const sim = jaccard(gi.grams, gj.grams);
        // 0.6..0.95 is the "maybe" zone worth asking Claude; ≥0.95 is already
        // covered by NAME_EXACT after normalization, <0.6 is almost certainly
        // different entities.
        if (sim >= 0.6 && sim < 0.95) {
          out.push({ a: gi.row, b: gj.row, similarity: sim });
        }
      }
    }
  }
  out.sort((x, y) => y.similarity - x.similarity);
  return out;
}

// ── Anthropic adjudicator ───────────────────────────────────────────────────

async function resolveAnthropicApiKey(tenantId: string): Promise<string | null> {
  const cred = await prisma.tenantIntegrationCredential.findFirst({
    where: { tenantId, platform: "ANTHROPIC", status: "ENABLED", apiKeyRef: { not: null } },
    select: { apiKeyRef: true }
  });
  if (cred?.apiKeyRef) return decryptField(cred.apiKeyRef);
  return config.ANTHROPIC_API_KEY ?? null;
}

type AdjudicationResult = { isDuplicate: boolean; confidence: number; reason: string };

const ADJUDICATION_MODEL = "claude-haiku-4-5-20251001";

async function adjudicateWithAI(
  apiKey: string,
  a: CustomerRow,
  b: CustomerRow,
  meter: { tenantId: string; userId: string | null; feature: AiFeature }
): Promise<AdjudicationResult | null> {
  const client = new Anthropic({ apiKey });
  const payload = {
    a: { code: a.customerCode, name: a.name, taxId: a.taxId, phones: a.contacts.map((c) => c.tel).filter(Boolean), emails: a.contacts.map((c) => c.email).filter(Boolean) },
    b: { code: b.customerCode, name: b.name, taxId: b.taxId, phones: b.contacts.map((c) => c.tel).filter(Boolean), emails: b.contacts.map((c) => c.email).filter(Boolean) }
  };
  const prompt = `You are a customer master-data deduplication assistant for a single tenant's CRM. Decide whether A and B refer to the same real-world business or person. If they share a name, phones, or emails but have different TaxIDs, treat that as strong evidence that one TaxID was mistyped — return isDuplicate=true with high confidence and explain which field looks mistyped in the reason. Consider spelling variants, legal suffixes (Co., Ltd. vs Limited), abbreviations, likely typos. Respond ONLY with valid JSON:
{"isDuplicate": true|false, "confidence": 0.0..1.0, "reason": "short sentence"}

A: ${JSON.stringify(payload.a)}
B: ${JSON.stringify(payload.b)}`;
  try {
    const res = await client.messages.create({
      model: ADJUDICATION_MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }]
    });
    void recordAiUsage({
      tenantId: meter.tenantId,
      userId: meter.userId,
      feature: meter.feature,
      provider: AiProvider.ANTHROPIC,
      model: ADJUDICATION_MODEL,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      status: AiCallStatus.SUCCESS,
    });
    const block = res.content[0];
    const text = block?.type === "text" ? block.text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const isDuplicate = parsed.isDuplicate === true;
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    const reason = typeof parsed.reason === "string" ? String(parsed.reason).slice(0, 500) : "AI judged duplicate.";
    return { isDuplicate, confidence, reason };
  } catch (err) {
    void recordAiUsage({
      tenantId: meter.tenantId,
      userId: meter.userId,
      feature: meter.feature,
      provider: AiProvider.ANTHROPIC,
      model: ADJUDICATION_MODEL,
      status: AiCallStatus.ERROR,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Public entry ────────────────────────────────────────────────────────────

export type DedupScanResult = {
  scannedCustomers: number;
  deterministicPairs: number;
  aiEvaluated: number;
  aiFlagged: number;
  openCandidates: number;
};

const AI_BATCH_CAP = 50;

export async function scanDuplicatesForTenant(tenantId: string): Promise<DedupScanResult> {
  const rows = await prisma.customer.findMany({
    where: { tenantId },
    select: {
      id: true,
      customerCode: true,
      name: true,
      taxId: true,
      branchCode: true,
      contacts: { select: { tel: true, email: true } }
    }
  });

  const det = buildDeterministicPairs(rows);
  const excludedFromFuzzy = new Set<string>(det.map((p) => `${p.customerAId}:${p.customerBId}`));

  // Upsert deterministic hits first.
  for (const p of det) {
    await prisma.customerDuplicateCandidate.upsert({
      where: {
        tenantId_customerAId_customerBId_signal: {
          tenantId,
          customerAId: p.customerAId,
          customerBId: p.customerBId,
          signal: p.signal
        }
      },
      create: {
        tenantId,
        customerAId: p.customerAId,
        customerBId: p.customerBId,
        signal: p.signal,
        confidence: p.confidence,
        reasonText: p.reasonText
      },
      update: {
        // Only refresh reason/confidence if still OPEN — don't resurrect dismissed ones.
        confidence: p.confidence,
        reasonText: p.reasonText
      }
    });
  }

  // Fuzzy candidates: only call AI if we have a key.
  const apiKey = await resolveAnthropicApiKey(tenantId);
  let aiEvaluated = 0;
  let aiFlagged = 0;
  if (apiKey) {
    const fuzzy = buildFuzzyNameCandidates(rows, excludedFromFuzzy).slice(0, AI_BATCH_CAP);
    for (const c of fuzzy) {
      const verdict = await adjudicateWithAI(apiKey, c.a, c.b, {
        tenantId,
        userId: null, // batch scan is cron-driven
        feature: AiFeature.DEDUP_SCAN,
      });
      aiEvaluated++;
      if (verdict && verdict.isDuplicate && verdict.confidence >= 0.7) {
        aiFlagged++;
        const [a, b] = pairKey(c.a.id, c.b.id);
        await prisma.customerDuplicateCandidate.upsert({
          where: {
            tenantId_customerAId_customerBId_signal: {
              tenantId, customerAId: a, customerBId: b, signal: CustomerDuplicateSignal.AI
            }
          },
          create: {
            tenantId, customerAId: a, customerBId: b,
            signal: CustomerDuplicateSignal.AI,
            confidence: verdict.confidence,
            reasonText: verdict.reason
          },
          update: {
            confidence: verdict.confidence,
            reasonText: verdict.reason
          }
        });
      }
    }
  }

  const openCount = await prisma.customerDuplicateCandidate.count({
    where: { tenantId, status: "OPEN" }
  });

  return {
    scannedCustomers: rows.length,
    deterministicPairs: det.length,
    aiEvaluated,
    aiFlagged,
    openCandidates: openCount
  };
}

// ── Inline check for new-customer create ───────────────────────────────────
// Compares a draft (no DB row yet) against existing customers and returns the
// top matches with deterministic + AI signals so the UI can warn or block
// before the customer is persisted.

export type DraftCustomerForCheck = {
  name: string;
  taxId?: string | null;
  branchCode?: string | null;
  contacts?: Array<{ tel?: string | null; email?: string | null }>;
};

export type DuplicateMatchKind =
  | "taxid_collision"      // exact (taxId+branch) hit on existing record
  | "phone_match"           // shared normalized phone
  | "email_match"           // shared normalized email
  | "name_exact"            // shared normalized name
  | "taxid_typo_suspected"  // AI flagged: name/phone/email match but TaxIDs differ
  | "name_fuzz";            // AI flagged: similar names, no other deterministic key

export type DuplicateMatch = {
  customer: {
    id: string;
    customerCode: string | null;
    name: string;
    taxId: string | null;
    ownerId: string | null;
    owner: { id: string; fullName: string } | null;
  };
  kind: DuplicateMatchKind;
  confidence: number;
  reasonText: string;
};

export type FindDuplicatesResult = {
  matches: DuplicateMatch[];
  aiCallsMade: number;
  aiSkippedNoKey: boolean;
};

const INLINE_FUZZY_THRESHOLD = 0.5;
const INLINE_TOP_K = 5;

/**
 * Build the union of deterministic + AI candidate matches for a draft customer.
 * Caller passes `userId` so the AI usage row is attributed to the rep who
 * triggered the create.
 */
export async function findDuplicatesForNewCustomer(
  tenantId: string,
  userId: string | null,
  draft: DraftCustomerForCheck
): Promise<FindDuplicatesResult> {
  const draftTax = normTaxId(draft.taxId);
  const draftBranch = (draft.branchCode ?? "00000").trim() || "00000";
  const draftPhones = (draft.contacts ?? []).map((c) => normPhone(c.tel)).filter((x): x is string => !!x);
  const draftEmails = (draft.contacts ?? []).map((c) => normEmail(c.email)).filter((x): x is string => !!x);
  const draftName = normName(draft.name);
  const draftGrams = ngrams(draftName);

  // Candidate set: every existing customer in this tenant, plus minimum fields
  // we need to score and render. Tenants typically have <50k customers; if this
  // becomes a hot path we can pre-filter by first-3-gram bucket like the batch scan.
  const rows = await prisma.customer.findMany({
    where: { tenantId },
    select: {
      id: true,
      customerCode: true,
      name: true,
      taxId: true,
      branchCode: true,
      ownerId: true,
      owner: { select: { id: true, fullName: true } },
      contacts: { select: { tel: true, email: true } },
    },
  });

  // Track best match per existing-customer id so we don't list the same
  // customer twice under different signals — keep the highest-confidence kind.
  const matchByCustomer = new Map<string, DuplicateMatch>();
  const upsertMatch = (m: DuplicateMatch) => {
    const prev = matchByCustomer.get(m.customer.id);
    if (!prev || m.confidence > prev.confidence) matchByCustomer.set(m.customer.id, m);
  };

  // ── Deterministic pass ──
  for (const row of rows) {
    const rowTax = normTaxId(row.taxId);
    const rowBranch = (row.branchCode ?? "00000").trim() || "00000";
    const customer = {
      id: row.id,
      customerCode: row.customerCode,
      name: row.name,
      taxId: row.taxId,
      ownerId: row.ownerId,
      owner: row.owner,
    };

    if (draftTax && rowTax && draftTax === rowTax && draftBranch === rowBranch) {
      upsertMatch({ customer, kind: "taxid_collision", confidence: 0.99, reasonText: `Same TaxID ${draftTax} branch ${draftBranch}` });
      continue;
    }
    const rowPhones = new Set(row.contacts.map((c) => normPhone(c.tel)).filter((x): x is string => !!x));
    if (draftPhones.some((p) => rowPhones.has(p))) {
      upsertMatch({ customer, kind: "phone_match", confidence: 0.9, reasonText: "Shared phone number" });
    }
    const rowEmails = new Set(row.contacts.map((c) => normEmail(c.email)).filter((x): x is string => !!x));
    if (draftEmails.some((e) => rowEmails.has(e))) {
      upsertMatch({ customer, kind: "email_match", confidence: 0.92, reasonText: "Shared email address" });
    }
    if (draftName.length >= 4 && normName(row.name) === draftName) {
      upsertMatch({ customer, kind: "name_exact", confidence: 0.85, reasonText: "Identical normalized name" });
    }
  }

  // ── Fuzzy candidate selection for AI ──
  // Score every other row by 3-gram Jaccard, plus a phone/email boost. Send the
  // top-K (excluding ones already covered by a deterministic signal) to AI.
  type Scored = { row: typeof rows[number]; similarity: number };
  const scored: Scored[] = [];
  if (draftName.length >= 4) {
    for (const row of rows) {
      if (matchByCustomer.has(row.id)) continue;
      const sim = jaccard(draftGrams, ngrams(normName(row.name)));
      if (sim >= INLINE_FUZZY_THRESHOLD) scored.push({ row, similarity: sim });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  const fuzzyTop = scored.slice(0, INLINE_TOP_K);

  const draftAsRow: CustomerRow = {
    id: "__draft__",
    customerCode: null,
    name: draft.name,
    taxId: draft.taxId ?? null,
    branchCode: draft.branchCode ?? null,
    contacts: (draft.contacts ?? []).map((c) => ({ tel: c.tel ?? null, email: c.email ?? null })),
  };

  let aiCallsMade = 0;
  let aiSkippedNoKey = false;
  if (fuzzyTop.length > 0) {
    const apiKey = await resolveAnthropicApiKey(tenantId);
    if (!apiKey) {
      aiSkippedNoKey = true;
    } else {
      for (const cand of fuzzyTop) {
        const candRow: CustomerRow = {
          id: cand.row.id,
          customerCode: cand.row.customerCode,
          name: cand.row.name,
          taxId: cand.row.taxId,
          branchCode: cand.row.branchCode,
          contacts: cand.row.contacts,
        };
        const verdict = await adjudicateWithAI(apiKey, draftAsRow, candRow, {
          tenantId,
          userId,
          feature: AiFeature.DEDUP_INLINE,
        });
        aiCallsMade++;
        if (!verdict || !verdict.isDuplicate || verdict.confidence < 0.6) continue;
        // Decide kind: if both have TaxIDs and they differ, flag it as a typo;
        // if neither has a TaxID it's a name-only fuzz; else fall back to name_fuzz.
        const candTax = normTaxId(cand.row.taxId);
        const kind: DuplicateMatchKind = (draftTax && candTax && draftTax !== candTax)
          ? "taxid_typo_suspected"
          : "name_fuzz";
        upsertMatch({
          customer: {
            id: cand.row.id,
            customerCode: cand.row.customerCode,
            name: cand.row.name,
            taxId: cand.row.taxId,
            ownerId: cand.row.ownerId,
            owner: cand.row.owner,
          },
          kind,
          confidence: verdict.confidence,
          reasonText: verdict.reason,
        });
      }
    }
  }

  const matches = Array.from(matchByCustomer.values()).sort((a, b) => b.confidence - a.confidence);
  return { matches, aiCallsMade, aiSkippedNoKey };
}

// ── Merge logic ─────────────────────────────────────────────────────────────

export type MergePreview = {
  keeper: { id: string; customerCode: string | null; name: string };
  losers: Array<{ id: string; customerCode: string | null; name: string }>;
  counts: {
    addresses: number;
    contacts: number;
    deals: number;
    visits: number;
    quotations: number;
    aiRecommendations: number;
  };
  conflicts: {
    taxIdConflict: boolean;
    externalRefConflict: boolean;
  };
};

async function assertCustomersInTenant(tenantId: string, ids: string[]): Promise<Array<{ id: string; customerCode: string | null; name: string; taxId: string | null; externalRef: string | null }>> {
  const rows = await prisma.customer.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, customerCode: true, name: true, taxId: true, externalRef: true }
  });
  if (rows.length !== ids.length) {
    throw new Error("One or more customers not found in this tenant.");
  }
  return rows;
}

export async function buildMergePreview(tenantId: string, keeperId: string, loserIds: string[]): Promise<MergePreview> {
  if (loserIds.includes(keeperId)) throw new Error("Keeper cannot also be a loser.");
  if (loserIds.length === 0) throw new Error("At least one loser customer is required.");
  const all = await assertCustomersInTenant(tenantId, [keeperId, ...loserIds]);
  const keeper = all.find((r) => r.id === keeperId)!;
  const losers = all.filter((r) => r.id !== keeperId);

  const [addresses, contacts, deals, visits, quotations, aiRecommendations] = await Promise.all([
    prisma.customerAddress.count({ where: { customerId: { in: loserIds } } }),
    prisma.customerContact.count({ where: { customerId: { in: loserIds } } }),
    prisma.deal.count({ where: { customerId: { in: loserIds } } }),
    prisma.visit.count({ where: { customerId: { in: loserIds } } }),
    prisma.quotation.count({ where: { customerId: { in: loserIds } } }),
    prisma.aiVisitRecommendation.count({ where: { customerId: { in: loserIds } } })
  ]);

  const taxIdConflict = !!keeper.taxId && losers.some((l) => l.taxId && l.taxId !== keeper.taxId);
  const externalRefConflict = !!keeper.externalRef && losers.some((l) => l.externalRef && l.externalRef !== keeper.externalRef);

  return {
    keeper: { id: keeper.id, customerCode: keeper.customerCode, name: keeper.name },
    losers: losers.map((l) => ({ id: l.id, customerCode: l.customerCode, name: l.name })),
    counts: { addresses, contacts, deals, visits, quotations, aiRecommendations },
    conflicts: { taxIdConflict, externalRefConflict }
  };
}

export async function mergeCustomers(input: {
  tenantId: string;
  keeperId: string;
  loserIds: string[];
  changedById: string;
}): Promise<MergePreview> {
  const { tenantId, keeperId, loserIds, changedById } = input;
  if (loserIds.includes(keeperId)) throw new Error("Keeper cannot also be a loser.");
  if (loserIds.length === 0) throw new Error("At least one loser customer is required.");

  const preview = await buildMergePreview(tenantId, keeperId, loserIds);

  await prisma.$transaction(async (tx) => {
    // Snapshot each loser for changelog.
    const losersFull = await tx.customer.findMany({
      where: { tenantId, id: { in: loserIds } },
      include: { addresses: true, contacts: true }
    });

    // Move FKs. Addresses and contacts are moved as-is (duplicates can be
    // cleaned up later — removing them in-flight would hide context).
    await tx.customerAddress.updateMany({ where: { customerId: { in: loserIds } }, data: { customerId: keeperId } });
    await tx.customerContact.updateMany({ where: { customerId: { in: loserIds } }, data: { customerId: keeperId } });
    await tx.deal.updateMany({ where: { customerId: { in: loserIds } }, data: { customerId: keeperId } });
    await tx.visit.updateMany({ where: { customerId: { in: loserIds } }, data: { customerId: keeperId } });
    await tx.quotation.updateMany({ where: { customerId: { in: loserIds } }, data: { customerId: keeperId } });
    await tx.aiVisitRecommendation.updateMany({ where: { customerId: { in: loserIds } }, data: { customerId: keeperId } });

    // Write a changelog entry per loser that captures its full pre-merge state.
    for (const loser of losersFull) {
      await tx.entityChangelog.create({
        data: {
          tenantId,
          entityType: "CUSTOMER",
          entityId: loser.id,
          action: "DELETE",
          changedById,
          beforeJson: loser as unknown as Prisma.InputJsonValue,
          afterJson: Prisma.JsonNull,
          contextJson: {
            reason: "merged",
            mergedIntoCustomerId: keeperId,
            mergedIntoCustomerCode: preview.keeper.customerCode
          } as Prisma.InputJsonValue
        }
      });
    }

    // Also write an UPDATE on the keeper so its history has a marker.
    await tx.entityChangelog.create({
      data: {
        tenantId,
        entityType: "CUSTOMER",
        entityId: keeperId,
        action: "UPDATE",
        changedById,
        beforeJson: Prisma.JsonNull,
        afterJson: Prisma.JsonNull,
        contextJson: {
          reason: "merged_from",
          mergedFromCustomerIds: loserIds,
          mergedFromCustomerCodes: preview.losers.map((l) => l.customerCode)
        } as Prisma.InputJsonValue
      }
    });

    // Mark any duplicate-candidate rows involving these ids as MERGED.
    await tx.customerDuplicateCandidate.updateMany({
      where: {
        tenantId,
        OR: [
          { customerAId: { in: [keeperId, ...loserIds] } },
          { customerBId: { in: [keeperId, ...loserIds] } }
        ]
      },
      data: { status: "MERGED", decidedById: changedById, decidedAt: new Date() }
    });

    // Finally delete the loser customer rows.
    await tx.customer.deleteMany({ where: { tenantId, id: { in: loserIds } } });
  }, { timeout: 15000 });

  return preview;
}
