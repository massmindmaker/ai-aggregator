import { z } from "zod";
import { calculateTokenCharge } from "./billing/token-quote";

/**
 * Plan 04 gateway configuration loader (zod-validated).
 * Reads from process.env at import time. Tests can override via env before import.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(8787),
  DATABASE_URL: z.string().default("postgres://localhost:5432/aiag_test"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  GATEWAY_HTTP_EXECUTION_MODE: z
    .enum(["legacy", "stored_chat_only"])
    .default("legacy"),
  // CBR endpoints (FIX H5/H6)
  CBR_URL: z.string().default("https://www.cbr.ru/scripts/XML_daily.asp"),
  CBR_FALLBACK_URL: z.string().optional(),
  CBR_RATE_SPREAD_PCT: z.coerce.number().default(2),
  // Applied only when the client omits max_tokens.
  GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(4096),
  // Pricing
  DEFAULT_MARKUP: z.coerce.number().default(1.25),
  BATCH_DISCOUNT: z.coerce.number().default(0.5),
  CACHING_DISCOUNT: z.coerce.number().default(0.5),
  // T1 (2026-07-16): replaces BYOK_FEE_RUB (0.5 ₽) now that org buckets are
  // MICRO-credit denominated. This value is WHOLE credits (admin-facing,
  // 1 credit = 1¢) — lib/pricing.ts's calcByokFeeCredits() converts it to
  // micro-credits (× 1000) before it ever reaches settleCharge. 1 credit ≈
  // the old 0.5₽ fee at the reference ~92₽/$ rate (0.5/92*100 ≈ 0.54¢ →
  // rounds to 1). Open question (finmodel-build-spec §10 Q3) — founder to
  // confirm the BYOK fee amount; 1 is the minimal-viable default, not a
  // re-derived price.
  BYOK_FEE_CREDITS: z.coerce.number().default(1),
  // Metrics
  METRICS_TOKEN: z.string().optional(),
  METRICS_PORT: z.coerce.number().default(9090),
  // Graceful shutdown
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().default(30_000),
});

const parsed = schema.parse(process.env);
// Preserve the exact operator input for the future stored-chat quote. The legacy
// number remains untouched for existing pricing callers.
const storedChatCachingDiscountExact = process.env.CACHING_DISCOUNT ?? "0.5";

if (parsed.GATEWAY_HTTP_EXECUTION_MODE === "stored_chat_only") {
  // This calls the existing exact decimal parser/range contract without deriving
  // a second price source from the Number-coerced legacy value.
  calculateTokenCharge(
    { inputCentsPer1k: "0", outputCentsPer1k: "0", markup: "1" },
    { promptTokens: 0, completionTokens: 0, cachedInputTokens: 0 },
    storedChatCachingDiscountExact,
  );
}

export type AppConfig = z.infer<typeof schema> &
  Readonly<{ STORED_CHAT_CACHING_DISCOUNT_EXACT: string }>;

export const config: AppConfig = Object.freeze({
  ...parsed,
  STORED_CHAT_CACHING_DISCOUNT_EXACT: storedChatCachingDiscountExact,
});
