/**
 * Plan 08 Task 19 (C2) — Pre-production boot-time check.
 *
 * Запускается deploy pipeline'ом ПЕРЕД pm2 reload. Если какой-то hard gate
 * не пройден — exit 1, deploy останавливается.
 *
 * Hard gates:
 *   - NODE_ENV=production + отсутствует RKN_OPERATOR_NUMBER → fail (152-ФЗ ч.1 ст.22)
 *   - DPO_EMAIL не задан
 *   - DATABASE_URL не задан
 *
 * Warnings (не fail):
 *   - YANDEX_CLOUD_MODERATOR_API_KEY отсутствует → moderation degraded
 *   - TELEGRAM_ALERT_BOT_TOKEN отсутствует → alerts не будут доставлены
 */

function fail(msg: string): never {
  console.error(`[PREFLIGHT-FAIL] ${msg}`);
  process.exit(1);
}

function warn(msg: string) {
  console.warn(`[PREFLIGHT-WARN] ${msg}`);
}

function main() {
  const isProd = process.env.NODE_ENV === 'production';

  // --- Hard gates (production only) ---
  if (isProd) {
    // РКН/DPO downgraded to warnings on owner request — owner accepts compliance
    // debt and will populate these envs before opening real traffic to PDn flows.
    if (!process.env.RKN_OPERATOR_NUMBER) {
      warn(
        'RKN_OPERATOR_NUMBER not set — running without РКН registration. ' +
          'Per 152-ФЗ ч.1 ст.22 must be set before processing real PDn.'
      );
    }
    if (!process.env.DPO_EMAIL && !process.env.NEXT_PUBLIC_DPO_EMAIL) {
      warn('DPO_EMAIL not set — 152-ФЗ ст.22.1 requires it before public traffic.');
    }
    if (!process.env.DATABASE_URL) {
      fail('DATABASE_URL not set.');
    }
  }

  // --- Warnings ---
  if (!process.env.YANDEX_CLOUD_MODERATOR_API_KEY) {
    warn('YANDEX_CLOUD_MODERATOR_API_KEY not set — moderation will use fallback only.');
  }
  if (!process.env.LLAMA_MODERATION_ENDPOINT) {
    warn('LLAMA_MODERATION_ENDPOINT not set — no fallback for moderation.');
  }
  if (!process.env.TELEGRAM_ALERT_BOT_TOKEN) {
    warn('TELEGRAM_ALERT_BOT_TOKEN not set — Alertmanager webhook not functional.');
  }
  if (isProd && !process.env.REDIS_URL) {
    warn('REDIS_URL not set in production — rate-limit + cache will degrade.');
  }

  console.log('[PREFLIGHT-OK] All hard gates passed.');
}

main();
