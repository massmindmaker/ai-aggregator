/**
 * znak.ts — deterministic «Личный ЗНАК» generator for the ГЛУБИНА chamber.
 *
 * The Знак is a collectible lore mark. It grants nothing — it only *remembers*
 * the visitor. Everything here is pure/deterministic given a seed string, so
 * the same person always sees the same mark.
 *
 * Persistence (browser-only): a stable random seed is stored in
 * localStorage('manifesto:znak'). If absent, one is minted and saved, so the
 * Знак is stable for this person/device across visits.
 */

export const ZNAK_STORAGE_KEY = 'manifesto:znak';

/** FNV-1a 32-bit — small, dependency-free, good enough for a lore hash. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A tiny seeded PRNG (mulberry32) so a seed yields a stable stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Znak {
  /** The raw stable seed persisted in localStorage. */
  seed: string;
  /** Sequential-looking Хроника number, e.g. 04217 (always 5 digits, padded). */
  number: string;
  /** Short uppercase hash, e.g. "7F3A9C". */
  shortHash: string;
  /** Full struck-relic code line, e.g. "ЗНАК · No 04217 · 7F3A9C". */
  code: string;
  /** The personal pass-cipher, grouped for reading, e.g. "ЖВКР · ТАНЛ · ОПЫС".
   *  Pure (deterministic) Cyrillic letters — every glyph exists in the manifesto
   *  body, so the visitor can RE-ENTER by spelling it back into the text. */
  passcode: string;
  /** The same cipher normalised (no spaces/dots), for click-spelling match. */
  passKey: string;
  /** 0..1 deterministic values to skew the rendered sigil's geometry/glow. */
  facets: { hue: number; tilt: number; spread: number; pulse: number };
}

/** Clean Cyrillic alphabet for the pass-cipher — all common in the prose,
 *  skips look-alike / hard-to-spot glyphs (Й, Ъ, Ы, Ь, Ё). */
const CODE_ALPHABET = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ';

/**
 * Create a fresh, hard-to-guess seed. Uses crypto when available, falling back
 * to time+random. Format is opaque on purpose — it's just an identity token.
 */
export function mintSeed(): string {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore — fall through */
  }
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

/** Derive the full deterministic Знак from a stable seed string. */
export function deriveZnak(seed: string): Znak {
  const base = fnv1a(`aiag:глубина:${seed}`);
  const rnd = mulberry32(base);

  // Хроника number — deterministic, 1..99999, zero-padded to 5 digits.
  const num = 1 + Math.floor(rnd() * 99999);
  const number = String(num).padStart(5, '0');

  // Short hash — 6 hex chars, uppercase, derived from a second pass.
  const hashSrc = fnv1a(`${seed}:${base}`);
  const shortHash = hashSrc.toString(16).toUpperCase().padStart(8, '0').slice(0, 6);

  const code = `ЗНАК · No ${number} · ${shortHash}`;

  // Personal pass-cipher: 12 Cyrillic letters in 3 groups of 4, deterministic.
  const letters: string[] = [];
  for (let i = 0; i < 12; i++) {
    letters.push(CODE_ALPHABET[Math.floor(rnd() * CODE_ALPHABET.length)]!);
  }
  const passKey = letters.join('');
  const passcode = `${passKey.slice(0, 4)} · ${passKey.slice(4, 8)} · ${passKey.slice(8, 12)}`;

  const facets = {
    hue: rnd(), // small amber-temperature shift
    tilt: rnd(), // sigil rotation
    spread: rnd(), // node spread
    pulse: rnd(), // glow breathing offset
  };

  return { seed, number, shortHash, code, passcode, passKey, facets };
}

/**
 * Read the persisted seed or mint+persist a new one, then derive the Знак.
 * Must run in the browser. Returns a deterministic Znak for this visitor.
 */
export function loadOrCreateZnak(): Znak {
  let seed: string | null = null;
  try {
    seed = window.localStorage.getItem(ZNAK_STORAGE_KEY);
  } catch {
    /* storage blocked — fall through to ephemeral seed */
  }

  if (!seed) {
    seed = mintSeed();
    try {
      window.localStorage.setItem(ZNAK_STORAGE_KEY, seed);
    } catch {
      /* storage blocked — Знак will be stable only for this session */
    }
  }

  return deriveZnak(seed);
}
