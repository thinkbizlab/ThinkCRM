import { Anthropic } from "@anthropic-ai/sdk";
import { CustomerDuplicateSignal, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { decryptField } from "../../lib/secrets.js";

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

async function adjudicateWithAI(
  apiKey: string,
  a: CustomerRow,
  b: CustomerRow
): Promise<AdjudicationResult | null> {
  const client = new Anthropic({ apiKey });
  const payload = {
    a: { code: a.customerCode, name: a.name, taxId: a.taxId, phones: a.contacts.map((c) => c.tel).filter(Boolean), emails: a.contacts.map((c) => c.email).filter(Boolean) },
    b: { code: b.customerCode, name: b.name, taxId: b.taxId, phones: b.contacts.map((c) => c.tel).filter(Boolean), emails: b.contacts.map((c) => c.email).filter(Boolean) }
  };
  const prompt = `You are a customer master-data deduplication assistant for a single tenant's CRM. Decide whether A and B refer to the same real-world business or person. Consider: spelling variants, legal suffixes (Co., Ltd. vs Limited), shared tax IDs, shared phones or emails, likely typos. Respond ONLY with valid JSON:
{"isDuplicate": true|false, "confidence": 0.0..1.0, "reason": "short sentence"}

A: ${JSON.stringify(payload.a)}
B: ${JSON.stringify(payload.b)}`;
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }]
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
  } catch {
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
      const verdict = await adjudicateWithAI(apiKey, c.a, c.b);
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
