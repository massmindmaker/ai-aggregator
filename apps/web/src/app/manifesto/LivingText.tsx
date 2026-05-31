'use client';

/**
 * LivingText — the star mechanic of the Chronicle.
 *
 * The manifesto SPEAKS BACK. The reader clicks letters of the prose to "spell"
 * a word (they speak); the presence hidden inside the page ANSWERS by lighting
 * EXISTING letters of the manifesto, one by one, top→down — so every reply is
 * assembled from glyphs that were always there.
 *
 * Design constraints honoured here:
 *  - No React re-render over thousands of spans: we wrap glyphs once via a
 *    DocumentFragment (keeping the server-rendered reveal/theme intact) and
 *    thereafter mutate classList / inline custom props imperatively.
 *  - One rAF loop, one pointer listener (delegated on the prose root).
 *  - Cyrillic-safe grapheme splitting via Intl.Segmenter (graceful fallback).
 *  - Full prefers-reduced-motion path (no scramble, no scroll, no breath).
 *  - Eerie, not chatty: stays silent until earned, then ≤1 reply / 20s.
 *  - Loose warp coupling: fires window.__manifestoWarp?.() + a CustomEvent and
 *    listens for `manifesto:warpflash`, all optional so it degrades alone.
 *
 * Owns: this file + LivingText.css + presence/dialogue.ts + the presence route.
 */

import { useEffect } from 'react';
import { fallbackReply, normalizeSpelled } from './presence/dialogue';
import './LivingText.css';

/* ── Tunables ─────────────────────────────────────────────────────────── */
const PROXIMITY_RADIUS = 120; // px — ambient breath reach
const PROXIMITY_MAX = 15; // only the N nearest letters get style writes / frame
const BEAT_MIN = 90; // ms per lit letter (accelerates toward the end)
const BEAT_MAX = 160;
const WORD_GAP = 420; // ms pause between answer words
const REPLY_COOLDOWN_MS = 20_000; // ≤1 reply / 20s
const IDLE_MS = 30_000; // ~30s idle nudge once letters are noticed
const MIN_SPELL = 3; // first answer earned at ≥3 letters
const ACROSTIC = 'хроника'; // substring of the hidden «ХРОНИКА ПОМНИТ»

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
    // Typed loosely so this compiles even if the TS lib lacks Intl.Segmenter,
    // and falls back to code-point iteration where the runtime lacks it.
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

    /* ── 2. Split on mount: wrap each glyph via DocumentFragment ────────── */
    const spans: HTMLElement[] = []; // index → span, in document order
    const lettersByChar = new Map<string, number[]>(); // 'а' → [indices]

    const isLetter = (ch: string) => /[а-яёa-z0-9]/i.test(ch);

    const wrapTextNode = (node: Text) => {
      const text = node.nodeValue ?? '';
      if (!text || !text.trim()) return;
      const frag = document.createDocumentFragment();
      for (const g of graphemes(text)) {
        if (g === ' ' || g === '\n' || g === '\t' || /^\s+$/.test(g)) {
          frag.appendChild(document.createTextNode(g));
          continue;
        }
        const span = document.createElement('span');
        span.setAttribute('data-ch', '');
        const i = spans.length;
        span.setAttribute('data-i', String(i));
        span.textContent = g;
        spans.push(span);
        if (isLetter(g)) {
          const key = g.toLowerCase().replace(/ё/g, 'е');
          const bucket = lettersByChar.get(key);
          if (bucket) bucket.push(i);
          else lettersByChar.set(key, [i]);
        }
        frag.appendChild(span);
      }
      node.parentNode?.replaceChild(frag, node);
    };

    // Walk only text nodes, skipping nodes that are already wrapped or inside
    // interactive/script content. We snapshot first (the walk mutates the DOM).
    for (const container of containers) {
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(n) {
            const parent = (n as Text).parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            // Skip interactive content, already-wrapped glyphs, and the
            // author's own coloured emphasis (.m-em/.m-key/.m-refrain etc.) so
            // those keep their intended styling instead of the breath gradient.
            if (
              parent.closest(
                'a, button, code, [data-ch], .m-em, .m-key, .m-refrain, .m-pull, .m-amber-breathe',
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

    // Re-mount (React StrictMode double-invoke in dev): a previous pass already
    // wrapped the prose, so the walker found nothing new. Rebuild our index from
    // the existing spans and reset their transient state instead of bailing.
    if (spans.length === 0) {
      const existing = document.querySelectorAll<HTMLElement>(
        '.m-prose [data-ch]',
      );
      existing.forEach((span, i) => {
        span.setAttribute('data-i', String(i));
        span.classList.remove('lit', 'glow', 'settle', 'ghost', 'think');
        span.style.removeProperty('--g');
        spans.push(span);
        const g = span.textContent ?? '';
        if (isLetter(g)) {
          const key = g.toLowerCase().replace(/ё/g, 'е');
          const bucket = lettersByChar.get(key);
          if (bucket) bucket.push(i);
          else lettersByChar.set(key, [i]);
        }
      });
      document
        .querySelectorAll('.m-prose .lt-missing, .lt-rune')
        .forEach((el) => el.remove());
    }

    if (spans.length === 0) return;

    // Letter inventory (unique sorted) for the presence prompt.
    const inventory = Array.from(lettersByChar.keys())
      .filter((c) => /[а-я]/.test(c))
      .sort()
      .join('');

    /* ── 3. Geometry cache (centres) for proximity glow ────────────────── */
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

    /* ── 4. Reader input: speak by clicking ────────────────────────────── */
    const selected = new Set<number>();
    const spelledIdx: number[] = []; // click order
    let acrosticBuf = '';
    let awakened = false; // reader has clearly noticed letters glow
    let lastReplyAt = 0;
    let lastInteractAt = Date.now();
    let unknownTurn = 0;
    let speaking = false;

    const charOf = (i: number) =>
      (spans[i]!.textContent ?? '').toLowerCase().replace(/ё/g, 'е');

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const span = target.closest<HTMLElement>('[data-ch]');
      if (!span || !root.contains(span)) return;
      const i = Number(span.getAttribute('data-i'));
      if (Number.isNaN(i)) return;
      const ch = charOf(i);
      if (!/[а-яa-z0-9]/i.test(ch)) return; // ignore punctuation glyphs

      lastInteractAt = Date.now();
      if (!awakened) {
        awakened = true;
        root.classList.add('lt-awake');
      }

      if (selected.has(i)) {
        selected.delete(i);
        span.classList.remove('lit');
        const at = spelledIdx.lastIndexOf(i);
        if (at >= 0) spelledIdx.splice(at, 1);
      } else {
        selected.add(i);
        span.classList.remove('lit');
        // restart ignite animation
        void span.offsetWidth;
        span.classList.add('lit');
        spelledIdx.push(i);
      }

      // Track acrostic progress (any order forms the substring «хроника»).
      acrosticBuf = spelledIdx.map(charOf).join('');
      maybeAnswer();
    };

    /* ── 5. Trigger discipline ─────────────────────────────────────────── */
    const spelledWord = () =>
      normalizeSpelled(spelledIdx.map(charOf).join(''));

    const cooledDown = () => Date.now() - lastReplyAt >= REPLY_COOLDOWN_MS;

    const clearSelection = () => {
      for (const i of selected) spans[i]!.classList.remove('lit');
      selected.clear();
      spelledIdx.length = 0;
      acrosticBuf = '';
    };

    const maybeAnswer = () => {
      if (speaking || !cooledDown()) return;
      const word = spelledWord();
      const hitAcrostic =
        acrosticBuf.includes(ACROSTIC) || word.includes(ACROSTIC);
      if (word.length >= MIN_SPELL || hitAcrostic) {
        respond(word);
      }
    };

    /* ── 6. The answer: light existing letters top→down ────────────────── */
    const cursorByChar = new Map<string, number>(); // round-robin per letter
    const litTrail: number[] = []; // glyphs lit during the current answer
    let lastLitIndex = -1;

    const nextOccurrence = (ch: string): number | null => {
      const bucket = lettersByChar.get(ch);
      if (!bucket || bucket.length === 0) return null;
      // pick the next occurrence AFTER the last lit (scan forward), else wrap
      let chosen = -1;
      for (const idx of bucket) {
        if (idx > lastLitIndex) {
          chosen = idx;
          break;
        }
      }
      if (chosen === -1) {
        // round-robin fallback so repeats don't always reuse the first glyph
        const rr = (cursorByChar.get(ch) ?? 0) % bucket.length;
        chosen = bucket[rr]!;
        cursorByChar.set(ch, rr + 1);
      }
      return chosen;
    };

    let lastScrollAt = 0;
    const maybeScrollTo = (span: HTMLElement) => {
      if (reduceMotion) return;
      const now = performance.now();
      if (now - lastScrollAt < 500) return;
      const r = span.getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 80) {
        lastScrollAt = now;
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    let thinkTimers: number[] = [];
    const startThinking = () => {
      if (reduceMotion) return;
      // scatter shimmer on a handful of letters near the last interaction
      const pool = spelledIdx.length
        ? spelledIdx
        : Array.from({ length: Math.min(8, spans.length) }, (_, k) =>
            Math.floor((spans.length / 8) * k),
          );
      const original: { i: number; ch: string }[] = [];
      for (const i of pool.slice(-6)) {
        const span = spans[i];
        if (!span) continue;
        original.push({ i, ch: span.textContent ?? '' });
        span.classList.add('think');
      }
      const scrambleChars = '0123456789АБВГДЕЖЗИКЛМНОПРСТ#@';
      let ticks = 0;
      const id = window.setInterval(() => {
        ticks++;
        for (const { i } of original) {
          const span = spans[i];
          if (span) {
            span.textContent =
              scrambleChars[(Math.random() * scrambleChars.length) | 0];
          }
        }
        if (ticks > 6) {
          window.clearInterval(id);
          for (const { i, ch } of original) {
            const span = spans[i];
            if (span) {
              span.textContent = ch;
              span.classList.remove('think');
            }
          }
        }
      }, 70);
      thinkTimers.push(id);
    };
    const stopThinking = () => {
      thinkTimers.forEach((t) => window.clearInterval(t));
      thinkTimers = [];
      for (const s of spans) {
        if (s.classList.contains('think')) {
          s.classList.remove('think');
        }
      }
    };

    /** Fetch a reply (LLM route → server fallback; on route failure → local). */
    const fetchReply = async (word: string): Promise<string> => {
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
        /* route unreachable — fall through to local tree */
      }
      return fallbackReply(word, unknownTurn++);
    };

    /** Light one glyph for `ch`, or render a faint amber `_` if the page lacks it. */
    const lightGlyph = async (ch: string, isLast: boolean) => {
      const idx = nextOccurrence(ch);
      if (idx === null) {
        // The presence lacks this letter — emit a ghost underscore in place.
        const missing = document.createElement('span');
        missing.className = 'lt-missing';
        missing.textContent = '_';
        // park it after the last lit glyph if possible, else at prose start
        const anchor =
          lastLitIndex >= 0 ? spans[lastLitIndex] : spans[0];
        anchor?.after(missing);
        await sleep(reduceMotion ? 40 : 110);
        missing.remove();
        return;
      }
      const span = spans[idx]!;
      lastLitIndex = idx;
      maybeScrollTo(span);
      span.classList.remove('ghost');
      span.classList.add('glow');
      if (isLast) span.classList.add('settle');
      litTrail.push(idx);
    };

    const respond = async (word: string) => {
      speaking = true;
      lastReplyAt = Date.now();

      // brief "thinking" shimmer while the reply resolves
      startThinking();
      const reply = await fetchReply(word);
      stopThinking();

      // reset the scan so each answer flows top→down afresh
      lastLitIndex = -1;
      litTrail.length = 0;

      const words = reply.split(' ').filter(Boolean);
      const totalLetters = words.reduce((n, w) => n + w.length, 0);
      let done = 0;

      for (let wi = 0; wi < words.length; wi++) {
        const w = words[wi]!;
        const letters = graphemes(w);
        for (let li = 0; li < letters.length; li++) {
          const ch = letters[li]!.toLowerCase().replace(/ё/g, 'е');
          const isLast = wi === words.length - 1 && li === letters.length - 1;
          await lightGlyph(ch, isLast);
          done++;
          if (!isLast) {
            // accelerate toward the end: beat shrinks as we progress
            const t = totalLetters > 1 ? done / totalLetters : 1;
            const beat = reduceMotion
              ? 60
              : BEAT_MAX - (BEAT_MAX - BEAT_MIN) * t +
                (Math.random() * 24 - 12);
            await sleep(Math.max(40, beat));
          }
        }
        if (wi < words.length - 1) await sleep(reduceMotion ? 120 : WORD_GAP);
      }

      // settle: convert the lit trail into a faint lingering ghost
      await sleep(reduceMotion ? 200 : 520);
      for (const idx of litTrail) {
        const s = spans[idx]!;
        s.classList.remove('glow', 'settle');
        s.classList.add('ghost');
      }

      // the reader's own selection fades after the page has answered
      clearSelection();

      // Final payload → warp coupling (loose/optional).
      if (normalizeSpelled(word).includes(ACROSTIC)) {
        triggerWarp();
      }

      speaking = false;
    };

    /* ── 7. Warp coupling (StarField exposes the hook; degrade if absent) ─ */
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

    const onWarpFlash = () => {
      if (reduceMotion) return;
      const rune = document.createElement('div');
      rune.className = 'lt-rune';
      rune.textContent = 'ᚺ'; // a single cipher rune
      root.appendChild(rune);
      window.setTimeout(() => rune.remove(), 2400);
    };
    window.addEventListener('manifesto:warpflash', onWarpFlash);

    /* ── 8. Ambient proximity breath (single rAF; ≤15 nearest get writes) ─ */
    let pointerX = -9999;
    let pointerY = -9999;
    let glowing: number[] = []; // currently breathing indices (to reset)
    let raf = 0;

    const onPointerMove = (e: PointerEvent) => {
      // The breath only ever writes color/text-shadow (never font metrics), so
      // it is already touch-safe — no special-casing of pointerType needed.
      pointerX = e.clientX;
      pointerY = e.clientY;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (geomDirty) recomputeCenters();

      // reset last frame's breathers
      for (const i of glowing) spans[i]?.style.setProperty('--g', '0');
      glowing = [];

      if (pointerX < -9000) return;

      // find the nearest few within radius (cheap: scan, keep best PROXIMITY_MAX)
      const r2 = PROXIMITY_RADIUS * PROXIMITY_RADIUS;
      const near: { i: number; d: number }[] = [];
      for (let i = 0; i < spans.length; i++) {
        const dx = centers[i * 2]! - pointerX;
        const dy = centers[i * 2 + 1]! - pointerY;
        const d = dx * dx + dy * dy;
        if (d < r2) near.push({ i, d });
      }
      near.sort((a, b) => a.d - b.d);
      const top = near.slice(0, PROXIMITY_MAX);
      for (const { i, d } of top) {
        const g = 1 - Math.sqrt(d) / PROXIMITY_RADIUS; // 0..1
        spans[i]!.style.setProperty('--g', g.toFixed(3));
        glowing.push(i);
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
    root.addEventListener('pointerdown', onPointerDown);

    /* ── Idle nudge: once awakened, ~30s of silence earns a soft answer ── */
    const idleTimer = window.setInterval(() => {
      if (!awakened || speaking || !cooledDown()) return;
      if (Date.now() - lastInteractAt < IDLE_MS) return;
      lastInteractAt = Date.now();
      // a quiet self-spoken line — uses the known tree (no spell required)
      respond('ты');
    }, 5000);

    /* ── Cleanup ───────────────────────────────────────────────────────── */
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(idleTimer);
      stopThinking();
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', markDirty);
      window.removeEventListener('scroll', markDirty);
      window.removeEventListener('manifesto:warpflash', onWarpFlash);
      root.classList.remove('lt-awake');
    };
  }, []);

  return null;
}
