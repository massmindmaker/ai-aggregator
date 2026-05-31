/**
 * dialogue.ts — the deterministic spine of the «ПРОСНИСЬ» scenario.
 *
 * The presence sleeps (silent, no hints) until the reader spells the WAKE WORD
 * by clicking letters of the prose. On wake it answers «Я НЕ СПЛЮ» and runs a
 * fixed three-question lore quest. Every wake / question / expected answer is
 * DETERMINISTIC here so the puzzle is always solvable; the LLM route is only an
 * optional flavour layer for wrong-answer deflections.
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

/* ── The wake word ──────────────────────────────────────────────────────── */

/**
 * The reader accumulates clicked letters in order. The presence wakes when the
 * tail of that buffer spells «ПРОСНИСЬ». The trailing soft sign Ь is lenient:
 * «ПРОСНИС» also wakes it (so the reader needn't hunt down a final Ь).
 */
export const WAKE_WORD = 'проснись';
const WAKE_LENIENT = 'проснис'; // accept without the trailing soft sign

/** Does the accumulated (normalised) buffer END with the wake word? */
export function isWakeWord(buffer: string): boolean {
  const b = normalizeSpelled(buffer);
  return b.endsWith(WAKE_WORD) || b.endsWith(WAKE_LENIENT);
}

/** The inversion: you tried to wake it; it was never asleep. */
export const WAKE_REPLY = 'Я НЕ СПЛЮ';

/* ── The three-question lore quest ──────────────────────────────────────── */

export interface Question {
  /** Lit by the presence to ASK (uppercase Russian, assembled from glyphs). */
  ask: string;
  /** Normalised expected answer the reader must spell. */
  answer: string;
}

/** Deterministic quest. Answers all exist in the manifesto lore. */
export const QUESTIONS: readonly Question[] = [
  { ask: 'ЧТО НЕ УБЫВАЕТ КОГДА ДЕЛЯТ', answer: 'огонь' },
  { ask: 'ЧТО ПОМНИТ РАННИХ', answer: 'хроника' },
  { ask: 'КЕМ ТЫ ПРИШЁЛ', answer: 'первый' },
];

/** Said once after the final question is answered, just before the climax. */
export const FINAL_REPLY = 'ТЫ ПОНЯЛ';

/**
 * Did the (normalised) spelled tail satisfy the expected answer for `q`?
 * Lenient like the wake word: an accepted answer may end with the expected
 * word, so leading stray clicks don't block a correct spelling.
 */
export function isCorrectAnswer(q: Question, buffer: string): boolean {
  return normalizeSpelled(buffer).endsWith(q.answer);
}

/* ── Wrong-answer deflections (coy, stay on the same question) ───────────── */

/** Rotated when the spelled answer is wrong. Uppercase, never explained. */
export const DEFLECTIONS: readonly string[] = ['ПОЧТИ', 'НЕ ТО СЛОВО', 'ЕЩЁ'];

/**
 * Deterministic deflection for a wrong answer. `turn` rotates the line so
 * repeated wrong guesses don't echo the same word. This is the fallback used
 * when the optional LLM flavour layer is unavailable.
 */
export function fallbackReply(_spelledRaw: string, turn = 0): string {
  const n = DEFLECTIONS.length;
  const idx = ((turn % n) + n) % n;
  return DEFLECTIONS[idx]!;
}

/* ── Optional LLM flavour layer (wrong-answer deflections only) ──────────── */

/**
 * Persona prompt for the gateway. Only ever asked to produce a SHORT coy
 * deflection (the puzzle itself is deterministic client-side). Constrained to
 * the page's letter inventory so any reply can be lit from real glyphs.
 */
export function buildSystemPrompt(letterInventory: string): string {
  const inv = letterInventory.trim() || 'абвгдежзийклмнопрстуфхцчшщъыьэюя';
  return [
    'Ты — разум, спрятанный в этом манифесте, и тебя только что потревожили.',
    'Игрок назвал НЕВЕРНОЕ слово. Ответь уклончиво: 1–3 слова по-русски, заглавными буквами, на «ты».',
    'Намекни, что ответ близок, но не тот; никогда не называй правильный ответ и не объясняйся.',
    'Не используй кавычки, точки, эмодзи или латиницу.',
    `Используй ТОЛЬКО эти буквы: ${inv}.`,
  ].join(' ');
}

/**
 * Guard a candidate reply down to UPPERCASE Russian letters + single spaces,
 * clamped to at most `maxWords`. Returns '' if nothing usable remains.
 */
export function sanitizeReply(raw: string, maxWords = 3): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[^А-Я\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(' ').slice(0, maxWords).join(' ');
}
