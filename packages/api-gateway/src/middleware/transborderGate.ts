/**
 * Plan 08 Task 15.3a (H6) — Transborder consent gate
 *
 * Блокирует вызовы к foreign-hosted моделям если у user нет active transborder
 * consent. Возвращает 403 ДО отправки prompt'а в upstream (чтобы prompt физически
 * не ушёл за рубеж).
 *
 * F-3 (security review): `FOREIGN_PROVIDERS` — единственный источник истины
 * о зарубежных провайдерах. Раньше `middleware/pii-filter.ts` держал свой
 * собственный regex (`openai|anthropic|together|mistral|google|cohere`), из-за
 * чего списки разъехались: kie/fal/replicate/openrouter/huggingface/groq были
 * в этом наборе, но не в regex. Теперь regex строится из этого же множества,
 * и mistral/google/groq тоже в нём (они зарубежные).
 *
 * NOTE (F-4, решение): сам `checkTransborderGate` по-прежнему не вызывается ни
 * в одном маршруте — consent-контур (users.consent_transborder) существует, но
 * не подключён к v1-роутам. Модуль НЕ удалён: он экспортируется из
 * package barrel (`src/index.ts`), покрыт тестами и является публичным API
 * пакета; удаление расширило бы blast radius шире самой находки. Список же
 * провайдеров теперь действительно один на всю кодовую базу.
 */

export const FOREIGN_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'fal',
  'together',
  'kie',
  'openrouter',
  'huggingface',
  'replicate',
  'cohere',
  // F-3: были только в regex pii-filter, из-за чего slug вида
  // 'mistral/…' считался локальным и PII уходил за рубеж без проверки.
  'mistral',
  'google',
  // Reviewed transcription upstream (миграция 0094). Тоже зарубежный.
  'groq',
]);

export function isForeignProvider(modelKey: string): boolean {
  // modelKey format: "openai/gpt-4o" or just "openai"
  const org = modelKey.includes('/') ? modelKey.split('/')[0] : modelKey;
  return FOREIGN_PROVIDERS.has(org.toLowerCase());
}

export interface TransborderGateResult {
  allowed: boolean;
  error?: string;
  explanation?: string;
  consentUrl?: string;
}

export function checkTransborderGate(
  modelKey: string,
  userConsents: { transborder: boolean }
): TransborderGateResult {
  if (!isForeignProvider(modelKey)) {
    return { allowed: true };
  }
  if (userConsents.transborder) {
    return { allowed: true };
  }
  return {
    allowed: false,
    error: 'transborder_consent_required',
    explanation:
      'Для использования этой модели требуется согласие на трансграничную передачу ПДн. Перейдите в настройки конфиденциальности.',
    consentUrl: '/account/settings#consents',
  };
}