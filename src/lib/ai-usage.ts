import { AiCallStatus, AiFeature, AiProvider, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

// USD per 1M tokens. Update when providers change pricing.
// Token-priced models — for transcription see TRANSCRIBE_USD_PER_MIN below.
const PRICING_PER_MTOKEN: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.00, output: 5.00 },
  "claude-haiku-4-5":          { input: 1.00, output: 5.00 },
  "claude-sonnet-4-5":         { input: 3.00, output: 15.00 },
  "claude-opus-4-7":           { input: 15.00, output: 75.00 },
  "gpt-4o":                    { input: 2.50, output: 10.00 },
  "gpt-4o-mini":               { input: 0.15, output: 0.60 },
  "gemini-2.0-flash":          { input: 0.10, output: 0.40 },
  "gemini-1.5-pro":            { input: 1.25, output: 5.00 },
};

// OpenAI Whisper / gpt-4o-transcribe is priced per audio-minute, not per token.
const TRANSCRIBE_USD_PER_MIN = 0.006;

function computeCostUsd(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
}): number {
  // Transcription: priced by audio length.
  if (input.durationMs && input.durationMs > 0) {
    const minutes = input.durationMs / 60_000;
    return minutes * TRANSCRIBE_USD_PER_MIN;
  }
  const price = PRICING_PER_MTOKEN[input.model];
  if (!price) return 0; // Unknown model — record event but cost stays 0; bump pricing table when noticed.
  return (input.inputTokens / 1_000_000) * price.input + (input.outputTokens / 1_000_000) * price.output;
}

export interface RecordAiUsageInput {
  tenantId: string;
  userId: string | null;
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  status?: AiCallStatus;
  errorMessage?: string;
}

/**
 * Record one AI call for the per-tenant usage dashboard.
 *
 * Fire-and-forget from the caller's perspective: any DB failure is swallowed
 * with a warning so a metering glitch never breaks the underlying AI feature.
 */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  try {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    const durationMs = input.durationMs ?? null;
    const costUsd = computeCostUsd({ model: input.model, inputTokens, outputTokens, durationMs });
    await prisma.aiUsageEvent.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        feature: input.feature,
        provider: input.provider,
        model: input.model,
        inputTokens,
        outputTokens,
        durationMs,
        costUsd: new Prisma.Decimal(costUsd.toFixed(6)),
        status: input.status ?? AiCallStatus.SUCCESS,
        errorMessage: input.errorMessage?.slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    console.warn("[ai-usage] recordAiUsage failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}
