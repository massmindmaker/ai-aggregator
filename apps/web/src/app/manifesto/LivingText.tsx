'use client';

/**
 * LivingText — the «ПРОСНИСЬ» mechanic of the Chronicle.
 *
 * The manifesto SPEAKS BACK with its OWN body text. A constant, very slow amber
 * wave drifts down the page (the page breathes). The reader spells the WAKE
 * WORD «ПРОСНИСЬ» by clicking letters of the prose (a quiet «лента» echoes their
 * spelling). The presence then wakes: a contiguous run of REAL prose
 * characters — anchored where the reader was typing, flowing into the lines
 * below — lights up and ROLLS around its own axis (split-flap), re-forming into
 * the reply «Я НЕ СПЛЮ» right inside the text (proper spacing; even a space
 * becomes a letter where the word needs one). It burns, dissolves, and the
 * original words return. A fixed three-question lore quest follows; the climax
 * warps to the secret chamber.
 *
 * Design constraints honoured here:
 *  - No React re-render over thousands of spans: we wrap glyphs once via a
 *    DocumentFragment and thereafter mutate classList / textContent.
 *  - One rAF loop (ambient wave + cursor breath), one delegated pointer listener.
 *  - Cyrillic-safe grapheme splitting via Intl.Segmenter (graceful fallback).
 *  - Full prefers-reduced-motion path (no spin/wave — letters just resolve).
 *  - The body text is ALWAYS restored after the presence finishes a line.
 *  - Deterministic puzzle: wake word + the 3 Q&A are fixed (dialogue.ts).
 *  - Loose warp coupling: fires window.__manifestoWarp?.() + a CustomEvent.
 *
 * Owns: this file + LivingText.css + presence/dialogue.ts + the presence route.
 */

import { useEffect } from 'react';
import { deriveZnak, ZNAK_STORAGE_KEY } from './glubina/znak';
import {
  DEFLECTIONS,
  FINAL_REPLY,
  isCorrectAnswer,
  isWakeWord,
  normalizeSpelled,
  QUESTIONS,
  WAKE_REPLY,
} from './presence/dialogue';
import './LivingText.css';

/* ── Tunables ─────────────────────────────────────────────────────────── */
const PROXIMITY_RADIUS = 120; // px — ambient cursor-breath reach
const WAKE_BUFFER_MAX = 16; // keep only the tail of the accumulated clicks
const ROLL_GLYPHS = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ'; // reel chars (letters only)
const SLOT_STAGGER = 65; // ms between consecutive letters starting to roll
const ROLL_TICK = 45; // ms per glyph flip while a letter rolls
const ROLL_TICKS = 7; // glyphs a letter rolls through before it settles
const HOLD_MS = 2200; // ms a reply burns before it dissolves (questions persist)
const ANSWER_GAP = 6; // characters skipped between consecutive answers
const WAVE_PERIOD = 110000; // ms for the ambient wave to cross the viewport once
const WAVE_BAND = 30; // px — vertical thickness of the drifting wave
const WAVE_MAX = 0.5; // peak ambient glow contributed by the wave (0..1)

export default function LivingText() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.manifesto-root');
    if (!root) return;
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>('.m-prose'),
    );
    if (containers.length === 0) return;

    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    /* ── 1. Grapheme splitter (Cyrillic-safe) ──────────────────────────── */
    interface SegmentLike {
      segment: string;
    }
    interface SegmenterLike {
      segment(input: string): Iterable<SegmentLike>;
    }
    const SegmenterCtor = (
      Intl as unknown as {
        Segmenter?: new (
          locale: string,
          options: { granularity: string },
        ) => SegmenterLike;
      }
    ).Segmenter;
    const seg: SegmenterLike | null = SegmenterCtor
      ? new SegmenterCtor('ru', { granularity: 'grapheme' })
      : null;
    const graphemes = (s: string): string[] => {
      if (seg) return Array.from(seg.segment(s), (x) => x.segment);
      return Array.from(s); // code-point fallback — fine for Cyrillic
    };

    const isLetter = (ch: string) => /[а-яёa-z0-9]/i.test(ch);

    /* ── 2. Split on mount: wrap each glyph (and each space) via a fragment ─ */
    const wrapTextNode = (node: Text) => {
      const text = node.nodeValue ?? '';
      if (!text || !text.trim()) return;
      const frag = document.createDocumentFragment();
      for (const g of graphemes(text)) {
        if (g === '\n' || g === '\t') {
          frag.appendChild(document.createTextNode(g));
          continue;
        }
        if (/^\s+$/.test(g)) {
          // wrap the space too — the presence may turn it into a letter
          const sp = document.createElement('span');
          sp.setAttribute('data-sp', '');
          sp.textContent = g;
          frag.appendChild(sp);
          continue;
        }
        const span = document.createElement('span');
        span.setAttribute('data-ch', '');
        span.textContent = g;
        frag.appendChild(span);
      }
      node.parentNode?.replaceChild(frag, node);
    };

    // Walk only text nodes, skipping nodes already wrapped or inside
    // interactive/script content. We snapshot first (the walk mutates the DOM).
    for (const container of containers) {
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(n) {
            const parent = (n as Text).parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (
              parent.closest(
                'a, button, code, [data-ch], [data-sp], .m-em, .m-key, .m-refrain, .m-pull, .m-amber-breathe',
              )
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            return (n.nodeValue ?? '').trim()
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        },
      );
      const textNodes: Text[] = [];
      let cur = walker.nextNode();
      while (cur) {
        textNodes.push(cur as Text);
        cur = walker.nextNode();
      }
      textNodes.forEach(wrapTextNode);
    }

    /* ── 3. Rebuild indices from the DOM (works for fresh + StrictMode re-mount)
     *   spans[]     — letter glyphs (data-ch): clicks, cursor breath, the wave
     *   slotsSeq[]  — ALL characters (data-ch + data-sp) in document order: the
     *                 presence rewrites a contiguous run of these into its reply */
    const spans: HTMLElement[] = [];
    const lettersByChar = new Map<string, number[]>(); // 'а' → [span indices]
    Array.from(root.querySelectorAll<HTMLElement>('.m-prose [data-ch]')).forEach(
      (span, i) => {
        span.setAttribute('data-i', String(i));
        span.classList.remove('lit', 'lt-spin', 'lt-land', 'lt-on', 'lt-fade');
        span.style.removeProperty('--g');
        spans.push(span);
        const g = span.textContent ?? '';
        if (isLetter(g)) {
          const key = g.toLowerCase().replace(/ё/g, 'е');
          const bucket = lettersByChar.get(key);
          if (bucket) bucket.push(i);
          else lettersByChar.set(key, [i]);
        }
      },
    );
    if (spans.length === 0) return;

    const slotsSeq: HTMLElement[] = [];
    const slotIndexOf = new Map<HTMLElement, number>();
    Array.from(
      root.querySelectorAll<HTMLElement>('.m-prose [data-ch], .m-prose [data-sp]'),
    ).forEach((el, k) => {
      el.classList.remove('lt-spin', 'lt-land', 'lt-on', 'lt-fade');
      slotsSeq.push(el);
      slotIndexOf.set(el, k);
    });

    // Letter inventory (unique sorted) for the presence prompt.
    const inventory = Array.from(lettersByChar.keys())
      .filter((c) => /[а-я]/.test(c))
      .sort()
      .join('');

    /* ── 4. Geometry cache (centres) for the wave + cursor breath ──────── */
    const centers = new Float32Array(spans.length * 2);
    let geomDirty = true;
    const recomputeCenters = () => {
      for (let i = 0; i < spans.length; i++) {
        const r = spans[i]!.getBoundingClientRect();
        centers[i * 2] = r.left + r.width / 2;
        centers[i * 2 + 1] = r.top + r.height / 2;
      }
      geomDirty = false;
    };

    /* ── 5. Quest state machine ────────────────────────────────────────── */
    type Phase = 'sleeping' | 'questing' | 'done';
    let phase: Phase = 'sleeping';
    let questIndex = 0;
    let wrongTurn = 0;
    let speakCursor = 0; // position in slotsSeq where the next reply rewrites

    const selected = new Set<number>();
    const spelledIdx: number[] = [];
    let wakeBuffer = '';
    let speaking = false;
    const pendingRolls = new Set<number>(); // live roll intervals (cleared on unmount)
    // The active question stays "burning" in the text until the reader answers.
    let persistedTouched: { el: HTMLElement; orig: string }[] | null = null;

    // Re-entry: a returning visitor re-opens the door by spelling their saved
    // CODE back into the text (the code is pure Cyrillic — all of its letters
    // exist in the prose). The presence modal is the single door.
    let reentryBuf = '';
    let reentryKey = '';
    const refreshReentryKey = () => {
      try {
        const s = window.localStorage.getItem(ZNAK_STORAGE_KEY);
        reentryKey = s ? deriveZnak(s).passKey.toLowerCase() : '';
      } catch {
        reentryKey = '';
      }
    };
    refreshReentryKey();
    const enter = () => {
      triggerWarp(); // legacy warp event (harmless if nothing listens)
      try {
        sessionStorage.setItem('manifesto:awoke', '1');
      } catch {
        /* storage blocked — fine */
      }
      try {
        window.dispatchEvent(new CustomEvent('manifesto:enter'));
      } catch {
        /* ignore */
      }
    };

    const charOf = (i: number) =>
      (spans[i]!.textContent ?? '').toLowerCase().replace(/ё/g, 'е');

    const spelledWord = () => normalizeSpelled(spelledIdx.map(charOf).join(''));

    /* ── 5b. The reader's «лента»: echoes what they are spelling ───────── */
    let ribbon: HTMLDivElement | null = null;
    const ensureRibbon = () => {
      if (ribbon) return;
      ribbon = document.createElement('div');
      ribbon.className = 'lt-ribbon';
      ribbon.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ribbon);
    };
    const setRibbon = (text: string) => {
      ensureRibbon();
      const t = text.trim();
      if (!t) {
        ribbon!.classList.remove('show');
        ribbon!.textContent = '';
        return;
      }
      ribbon!.textContent = t.toUpperCase();
      ribbon!.classList.add('show');
    };

    const onPointerDown = (e: PointerEvent) => {
      if (speaking) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const span = target.closest<HTMLElement>('[data-ch]');
      if (!span || !root.contains(span)) return;
      const i = Number(span.getAttribute('data-i'));
      if (Number.isNaN(i)) return;
      const ch = charOf(i);
      if (!/[а-яa-z0-9]/i.test(ch)) return; // ignore punctuation glyphs

      if (!root.classList.contains('lt-awake')) root.classList.add('lt-awake');

      if (selected.has(i)) {
        selected.delete(i);
        span.classList.remove('lit');
        const at = spelledIdx.lastIndexOf(i);
        if (at >= 0) spelledIdx.splice(at, 1);
      } else {
        selected.add(i);
        span.classList.remove('lit');
        void span.offsetWidth; // restart ignite animation
        span.classList.add('lit');
        spelledIdx.push(i);
      }

      // Re-entry: spelling the saved code anywhere re-opens the presence modal.
      if (reentryKey) {
        reentryBuf = normalizeSpelled(reentryBuf + ch).slice(-24);
        if (reentryBuf.endsWith(reentryKey)) {
          reentryBuf = '';
          clearSelection();
          enter();
          return;
        }
      }

      if (phase === 'sleeping') {
        // Accumulate the click tail; wake when it spells the FULL «ПРОСНИСЬ».
        wakeBuffer = normalizeSpelled(wakeBuffer + ch).slice(-WAKE_BUFFER_MAX);
        setRibbon(wakeBuffer.slice(-12));
        if (isWakeWord(wakeBuffer)) {
          wakeBuffer = '';
          wake();
        }
      } else if (phase === 'questing') {
        const w = spelledWord();
        setRibbon(w.slice(-14));
        const q = QUESTIONS[questIndex]!;
        if (isCorrectAnswer(q, w)) {
          answerCorrect();
        }
      }
    };

    /* ── 6. Quest transitions ──────────────────────────────────────────── */
    const wake = () => {
      phase = 'questing';
      questIndex = 0;
      void speak(WAKE_REPLY, { after: () => askCurrentQuestion() });
    };

    const askCurrentQuestion = () => {
      const q = QUESTIONS[questIndex];
      if (!q) return;
      void speak(q.ask, { question: true });
    };

    const answerCorrect = () => {
      restorePersisted(); // the answered question dissolves
      questIndex++;
      if (questIndex >= QUESTIONS.length) {
        void speak(FINAL_REPLY, { after: () => climax() });
      } else {
        void speak(QUESTIONS[questIndex]!.ask, { question: true });
      }
    };

    const answerWrong = async () => {
      speaking = true; // lock immediately so the async fetch can't be raced
      const reply = await fetchDeflection(spelledWord());
      void speak(reply); // stay on the same question
    };

    const maybeDeflect = () => {
      if (phase !== 'questing' || speaking) return;
      const q = QUESTIONS[questIndex]!;
      const w = spelledWord();
      if (w.length > q.answer.length && !w.endsWith(q.answer)) {
        void answerWrong();
      }
    };

    /* ── 7. Climax → warp + navigate to the chamber ────────────────────── */
    const climax = () => {
      phase = 'done';
      enter(); // flash + open the cooperative-intelligence modal (Presence.tsx)
      refreshReentryKey(); // the code now exists → re-entry armed this session too
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /* ── 8. Roll ONE real character: spin it around its axis, settle on `ch` ─ */
    const rollSpan = (el: HTMLElement, target: string, delay: number) =>
      new Promise<void>((resolve) => {
        if (reduceMotion) {
          el.classList.add('lt-on', 'lt-land');
          el.textContent = target;
          resolve();
          return;
        }
        window.setTimeout(() => {
          let n = 0;
          el.classList.add('lt-spin');
          const id = window.setInterval(() => {
            n++;
            if (n >= ROLL_TICKS) {
              window.clearInterval(id);
              pendingRolls.delete(id);
              el.textContent = target;
              el.classList.remove('lt-spin');
              el.classList.add('lt-on', 'lt-land');
              resolve();
            } else {
              el.textContent =
                ROLL_GLYPHS[(Math.random() * ROLL_GLYPHS.length) | 0]!;
            }
          }, ROLL_TICK);
          pendingRolls.add(id);
        }, delay);
      });

    // Restore a frozen question's glyphs back to the original prose.
    const restorePersisted = () => {
      if (!persistedTouched) return;
      for (const { el, orig } of persistedTouched) {
        el.classList.remove('lt-spin', 'lt-land', 'lt-on', 'lt-fade', 'lt-q');
        el.style.removeProperty('--g');
        el.textContent = orig;
      }
      persistedTouched = null;
      geomDirty = true;
    };

    /* ── 8b. The presence speaks THROUGH the body text ──────────────────
     * Rewrite a contiguous run of real characters into `line`: each rolls into
     * place (a space becomes a letter where the word needs one; the answer's own
     * spaces stay gaps). A REPLY then burns, dissolves and restores. A QUESTION
     * is rendered larger (.lt-q) with a trailing «?» and FREEZES in the text —
     * it stays until the reader answers. Anchored where the reader just typed. */
    const speak = async (
      line: string,
      opts: { after?: () => void; question?: boolean } = {},
    ) => {
      const { after, question = false } = opts;
      speaking = true;
      setRibbon('');

      // Anchor just after the reader's most recent click; else continue down.
      if (selected.size > 0) {
        let maxSel = -1;
        for (const i of selected) if (i > maxSel) maxSel = i;
        const el = spans[maxSel];
        const p = el ? slotIndexOf.get(el) : undefined;
        if (p != null) {
          speakCursor = Math.min(p + 2, Math.max(0, slotsSeq.length - 1));
        }
      }
      clearSelection();

      const text = question ? `${line}?` : line;
      const touched: { el: HTMLElement; orig: string }[] = [];
      const rolls: Promise<void>[] = [];
      let firstEl: HTMLElement | null = null;
      let slot = 0;

      for (const g of Array.from(text)) {
        if (slotsSeq.length === 0) break;
        if (speakCursor >= slotsSeq.length) speakCursor = 0; // wrap around
        const el = slotsSeq[speakCursor++]!;
        touched.push({ el, orig: el.textContent ?? '' });
        if (!firstEl) firstEl = el;
        if (question) el.classList.add('lt-q');
        if (g === ' ') {
          el.classList.remove('lt-spin', 'lt-land', 'lt-on', 'lt-fade');
          el.textContent = ' '; // a real gap between the answer's words
          continue;
        }
        if (!/[a-zа-я0-9]/i.test(g)) {
          // punctuation (e.g. the «?») — place it directly, no roll
          el.textContent = g;
          el.classList.add('lt-on', 'lt-land');
          continue;
        }
        rolls.push(rollSpan(el, g.toUpperCase(), slot * SLOT_STAGGER));
        slot++;
      }

      if (firstEl && !reduceMotion) {
        const r = firstEl.getBoundingClientRect();
        if (r.top < 64 || r.bottom > window.innerHeight - 64) {
          firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      await Promise.all(rolls);
      speakCursor = Math.min(speakCursor + ANSWER_GAP, slotsSeq.length);

      if (question) {
        // freeze the question — it stays in the text until the reader answers
        persistedTouched = touched;
        speaking = false;
        after?.();
        return;
      }

      await sleep(HOLD_MS);

      // dissolve: the burning inscription fades, then the words return
      if (!reduceMotion) {
        for (const { el } of touched) el.classList.add('lt-fade');
        await sleep(320);
      }
      for (const { el, orig } of touched) {
        el.classList.remove('lt-spin', 'lt-land', 'lt-on', 'lt-fade', 'lt-q');
        el.style.removeProperty('--g');
        el.textContent = orig;
      }
      geomDirty = true;

      speaking = false;
      after?.();
    };

    const clearSelection = () => {
      for (const i of selected) spans[i]!.classList.remove('lit');
      selected.clear();
      spelledIdx.length = 0;
      setRibbon('');
    };

    /* ── 9. Optional LLM flavour for wrong-answer deflections ──────────── */
    const fetchDeflection = async (word: string): Promise<string> => {
      try {
        const res = await fetch('/api/manifesto/presence', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word, inventory }),
        });
        if (!res.ok) throw new Error('bad status');
        const data = (await res.json()) as { reply?: string };
        const reply = (data.reply ?? '').trim();
        if (reply) return reply;
      } catch {
        /* route unreachable — fall through to local deflection */
      }
      const n = DEFLECTIONS.length;
      return DEFLECTIONS[wrongTurn++ % n]!;
    };

    /* ── 10. Warp coupling (StarField exposes the hook; degrade if absent) ─ */
    const triggerWarp = () => {
      try {
        (
          window as unknown as { __manifestoWarp?: () => void }
        ).__manifestoWarp?.();
      } catch {
        /* ignore */
      }
      try {
        window.dispatchEvent(new CustomEvent('manifesto:warp'));
      } catch {
        /* ignore */
      }
    };

    /* ── 11. Ambient: a constant slow wave drifting down + cursor breath ─── */
    let pointerX = -9999;
    let pointerY = -9999;
    let glowing: number[] = [];
    let raf = 0;
    const waveStart = performance.now();

    const onPointerMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (speaking) {
        // don't fight the presence for these glyphs; just clear stale glows once
        if (glowing.length) {
          for (const i of glowing) spans[i]?.style.setProperty('--g', '0');
          glowing = [];
        }
        return;
      }
      if (geomDirty) recomputeCenters();

      const vh = window.innerHeight || 800;
      const t = ((performance.now() - waveStart) % WAVE_PERIOD) / WAVE_PERIOD;
      const bandY = t * vh; // the wave crest, in viewport coords, looping down
      const haveCursor = pointerX > -9000;
      const r2 = PROXIMITY_RADIUS * PROXIMITY_RADIUS;

      for (const i of glowing) spans[i]?.style.setProperty('--g', '0');
      glowing = [];

      for (let i = 0; i < spans.length; i++) {
        const cy = centers[i * 2 + 1]!;
        let g = 0;
        const bdy = Math.abs(cy - bandY);
        if (bdy < WAVE_BAND) g = (1 - bdy / WAVE_BAND) * WAVE_MAX;
        if (haveCursor) {
          const dx = centers[i * 2]! - pointerX;
          const dy = cy - pointerY;
          const d2 = dx * dx + dy * dy;
          if (d2 < r2) {
            const gc = 1 - Math.sqrt(d2) / PROXIMITY_RADIUS;
            if (gc > g) g = gc;
          }
        }
        if (g > 0.02) {
          spans[i]!.style.setProperty('--g', g.toFixed(3));
          glowing.push(i);
        }
      }
    };

    if (!reduceMotion) {
      recomputeCenters();
      raf = requestAnimationFrame(tick);
      root.addEventListener('pointermove', onPointerMove, { passive: true });
    }

    /* ── Geometry invalidation ─────────────────────────────────────────── */
    const markDirty = () => {
      geomDirty = true;
    };
    window.addEventListener('resize', markDirty, { passive: true });
    window.addEventListener('scroll', markDirty, { passive: true });

    /* ── Pointer listener (delegated — single listener on root) ────────── */
    const onPointerDownWrapped = (e: PointerEvent) => {
      onPointerDown(e);
      maybeDeflect();
    };
    root.addEventListener('pointerdown', onPointerDownWrapped);

    /* ── Cleanup ───────────────────────────────────────────────────────── */
    return () => {
      cancelAnimationFrame(raf);
      pendingRolls.forEach((id) => window.clearInterval(id));
      pendingRolls.clear();
      root.removeEventListener('pointerdown', onPointerDownWrapped);
      root.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', markDirty);
      window.removeEventListener('scroll', markDirty);
      root.classList.remove('lt-awake');
      ribbon?.remove();
    };
  }, []);

  return null;
}
