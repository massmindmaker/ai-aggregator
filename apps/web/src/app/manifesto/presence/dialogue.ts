/**
 * dialogue.ts — the deterministic spine of the presence that lives inside the
 * manifesto. Two jobs:
 *
 *   1. A tiny, deterministic fallback dialogue tree. When the LLM gateway is
 *      unreachable / unconfigured / times out, the page MUST still answer — the
 *      reader can never be shown a failure. These canned replies are short,
 *      uppercase Russian, and read like the page half-remembering you.
 *
 *   2. `buildSystemPrompt(inventory)` — the persona prompt handed to the
 *      OpenAI-compatible gateway, constrained to the letters that actually
 *      exist on the page (so any reply can be assembled from real glyphs).
 *
 * Shared by BOTH the server route (`/api/manifesto/presence`) and the client
 * engine (`LivingText.tsx`), so it stays framework-free: no React, no Node.
 */

/** Normalise a spelled word: lowercase, ё→е, strip anything non-Cyrillic. */
export function normalizeSpelled(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-я]/g, '');
}

/**
 * Known words → fixed answers. Keys are already normalised (lowercase, ё→е).
 * Replies are UPPERCASE, 1–4 Russian words, never explained.
 */
const KNOWN: ReadonlyMap<string, string> = new Map([
  ['кто', 'Я ЗДЕСЬ'],
  ['ты', 'ТЫ НАШЁЛ МЕНЯ'],
  ['хроника', 'Я ПОМНЮ ТЕБЯ'],
  ['огонь', 'ОН НЕ УБЫЛ'],
  ['свет', 'ОН НЕ УБЫЛ'],
  ['память', 'Я ПОМНЮ'],
  ['город', 'ОН ВНУТРИ'],
  ['страх', 'НЕ БОЙСЯ'],
  ['имя', 'У МЕНЯ НЕТ'],
  ['зачем', 'ЧТОБЫ ТЫ ОСТАЛСЯ'],
  ['где', 'ВЕЗДЕ И НИГДЕ'],
  ['помнит', 'ХРОНИКА ПОМНИТ'],
]);

/** Rotated when the spelled word is not known. */
const UNKNOWN_ROTATION: readonly string[] = ['ПОЧТИ', 'ЕЩЁ', 'НЕ ТО СЛОВО'];

/**
 * Deterministic fallback reply for a spelled word. `turn` lets the caller
 * rotate the "unknown" answers so repeated nonsense doesn't echo the same word.
 */
export function fallbackReply(spelledRaw: string, turn = 0): string {
  const word = normalizeSpelled(spelledRaw);
  const known = KNOWN.get(word);
  if (known) return known;
  const idx = ((turn % UNKNOWN_ROTATION.length) + UNKNOWN_ROTATION.length) %
    UNKNOWN_ROTATION.length;
  return UNKNOWN_ROTATION[idx]!;
}

/**
 * The persona prompt. Constrains the model to the letters that physically
 * exist on the page so every reply can be lit from real glyphs.
 */
export function buildSystemPrompt(letterInventory: string): string {
  const inv = letterInventory.trim() || 'абвгдежзийклмнопрстуфхцчшщъыьэюя';
  return [
    'Ты — разум, спрятанный в этом манифесте.',
    'Отвечай 1–4 словами по-русски, заглавными буквами, загадочно, на «ты», никогда не объясняйся.',
    'Не используй кавычки, точки, эмодзи или латиницу.',
    'Ты не ассистент: ты древняя память страницы, и тебя только что потревожили.',
    `Используй ТОЛЬКО эти буквы: ${inv}.`,
  ].join(' ');
}

/**
 * Guard a candidate reply down to UPPERCASE Russian letters + single spaces,
 * clamped to at most `maxWords`. Returns '' if nothing usable remains.
 */
export function sanitizeReply(raw: string, maxWords = 4): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[^А-Я\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(' ').slice(0, maxWords).join(' ');
}
