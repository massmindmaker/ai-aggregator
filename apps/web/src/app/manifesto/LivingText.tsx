'use client';

/**
 * LivingText — the «ПРОСНИСЬ» mechanic of the Chronicle.
 *
 * The manifesto SPEAKS BACK. Letters breathe amber near the cursor and turn
 * touchable. The reader discovers they can click letters and, in order, spell
 * the WAKE WORD «ПРОСНИСЬ» — a quiet «лента» echoes what they are spelling so
 * progress is always legible. The presence then wakes with the inversion
 * «Я НЕ СПЛЮ» and runs a fixed three-question lore quest.
 *
 * How the presence answers (legible by design): the letters of each reply
 * LIFT OUT of the surrounding prose and FLY into one focused, readable amber
 * line in the centre of the screen (FLIP). They hold, then drift back into the
 * text. No scramble, no scattered flashes — the page gathers its own glyphs
 * into a word you can actually read.
 *
 * Design constraints honoured here:
 *  - No React re-render over thousands of spans: we wrap glyphs once via a
 *    DocumentFragment and thereafter mutate classList / inline custom props.
 *  - One rAF loop, one pointer listener (delegated on the prose root).
 *  - Cyrillic-safe grapheme splitting via Intl.Segmenter (graceful fallback).
 *  - Full prefers-reduced-motion path (static legible reveal, no flight).
 *  - Deterministic puzzle: wake word + the 3 Q&A are fixed (dialogue.ts). The
 *    LLM route is consulted ONLY to flavour a wrong-answer deflection.
 *  - Loose warp coupling: fires window.__manifestoWarp?.() + a CustomEvent.
 *
 * Owns: this file + LivingText.css + presence/dialogue.ts + the presence route.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
const PROXIMITY_RADIUS = 120; // px — ambient breath reach
const PROXIMITY_MAX = 15; // only the N nearest letters get style writes / frame
const WAKE_BUFFER_MAX = 16; // keep only the tail of the accumulated clicks
const FLY_STAGGER = 55; // ms between consecutive letters arriving in the line
const FLY_TRAVEL = 540; // ms a single letter takes to fly in (mirror of CSS)
const HOLD_MS = 1550; // ms the assembled line lingers before it dissolves
const CHAMBER_ROUTE = '/manifesto/glubina'; // the secret chamber
const WARP_TO_NAV_MS = 1600; // let the warp play before navigating

export default function LivingText() {
  const router = useRouter();

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
        span.classList.remove('lit', 'ghost');
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

    /* ── 4. Quest state machine ────────────────────────────────────────── */
    // phase: 'sleeping'  → reader is spelling toward the wake word
    //        'questing'  → presence has woken; running the 3-question quest
    //        'done'      → final line said, climax fired
    type Phase = 'sleeping' | 'questing' | 'done';
    let phase: Phase = 'sleeping';
    let questIndex = 0; // which QUESTIONS[] we're on
    let wrongTurn = 0; // rotates the deflection line

    const selected = new Set<number>();
    const spelledIdx: number[] = []; // click order (resets each spell attempt)
    let wakeBuffer = ''; // accumulating tail of clicked letters (sleeping phase)
    let speaking = false;

    const charOf = (i: number) =>
      (spans[i]!.textContent ?? '').toLowerCase().replace(/ё/g, 'е');

    const spelledWord = () => normalizeSpelled(spelledIdx.map(charOf).join(''));

    /* ── 4b. The reader's «лента»: echoes what they are spelling ───────── */
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
      if (speaking || phase === 'done') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const span = target.closest<HTMLElement>('[data-ch]');
      if (!span || !root.contains(span)) return;
      const i = Number(span.getAttribute('data-i'));
      if (Number.isNaN(i)) return;
      const ch = charOf(i);
      if (!/[а-яa-z0-9]/i.test(ch)) return; // ignore punctuation glyphs

      // Mark the page as "discovered" so letters read as touchable (cursor).
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

      if (phase === 'sleeping') {
        // Accumulate the click tail; wake when it spells «ПРОСНИСЬ».
        wakeBuffer = normalizeSpelled(wakeBuffer + ch).slice(-WAKE_BUFFER_MAX);
        setRibbon(wakeBuffer.slice(-12)); // reader sees their spelling form
        if (isWakeWord(wakeBuffer)) {
          wakeBuffer = '';
          wake();
        }
      } else if (phase === 'questing') {
        // Check the running spelled word against the current expected answer.
        const w = spelledWord();
        setRibbon(w.slice(-14));
        const q = QUESTIONS[questIndex]!;
        if (isCorrectAnswer(q, w)) {
          answerCorrect();
        }
      }
    };

    /* ── 5. Quest transitions ──────────────────────────────────────────── */
    const wake = () => {
      phase = 'questing';
      questIndex = 0;
      void speak(WAKE_REPLY, () => askCurrentQuestion());
    };

    const askCurrentQuestion = () => {
      const q = QUESTIONS[questIndex];
      if (!q) return;
      void speak(q.ask);
    };

    const answerCorrect = () => {
      questIndex++;
      if (questIndex >= QUESTIONS.length) {
        // Final line, then the climax.
        void speak(FINAL_REPLY, () => climax());
      } else {
        // Brief affirmation by simply asking the next question.
        void speak(QUESTIONS[questIndex]!.ask);
      }
    };

    const answerWrong = async () => {
      const reply = await fetchDeflection(spelledWord());
      void speak(reply); // stay on the same question
    };

    /* The reader finished spelling but it doesn't match → deflect.
     * We can't know "finished" without a commit gesture, so wrong answers are
     * surfaced lazily: when the spelled buffer grows past the answer length
     * without matching, the next non-matching click triggers a deflection and
     * resets the attempt. */
    const maybeDeflect = () => {
      if (phase !== 'questing' || speaking) return;
      const q = QUESTIONS[questIndex]!;
      const w = spelledWord();
      if (w.length > q.answer.length && !w.endsWith(q.answer)) {
        void answerWrong();
      }
    };

    /* ── 6. Climax → warp + navigate to the chamber ────────────────────── */
    const climax = () => {
      phase = 'done';
      try {
        sessionStorage.setItem('manifesto:awoke', '1');
      } catch {
        /* storage unavailable — proceed anyway */
      }
      triggerWarp();
      window.setTimeout(() => {
        try {
          router.push(CHAMBER_ROUTE);
        } catch {
          window.location.href = CHAMBER_ROUTE;
        }
      }, WARP_TO_NAV_MS);
    };

    /* ── 7. Source-glyph picker (which existing letter "gives" its glyph) ─ */
    const cursorByChar = new Map<string, number>(); // round-robin per letter
    let lastSrcIndex = -1;

    const nextOccurrence = (ch: string): number | null => {
      const bucket = lettersByChar.get(ch);
      if (!bucket || bucket.length === 0) return null;
      let chosen = -1;
      for (const idx of bucket) {
        if (idx > lastSrcIndex) {
          chosen = idx;
          break;
        }
      }
      if (chosen === -1) {
        const rr = (cursorByChar.get(ch) ?? 0) % bucket.length;
        chosen = bucket[rr]!;
        cursorByChar.set(ch, rr + 1);
      }
      lastSrcIndex = chosen;
      return chosen;
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /* ── 7b. The presence speaks: letters fly into one readable line ────── */
    let voiceWrap: HTMLDivElement | null = null;
    let voiceLine: HTMLDivElement | null = null;
    const ensureVoice = () => {
      if (voiceWrap) return;
      voiceWrap = document.createElement('div');
      voiceWrap.className = 'lt-voice';
      voiceWrap.setAttribute('aria-hidden', 'true');
      voiceLine = document.createElement('div');
      voiceLine.className = 'lt-voice-line';
      voiceWrap.appendChild(voiceLine);
      document.body.appendChild(voiceWrap);
    };

    /**
     * Assemble `line` into the focus band by flying each letter out of the
     * prose, hold it, then dissolve back. Locks reader input for the duration.
     */
    const speak = async (line: string, after?: () => void) => {
      speaking = true;
      setRibbon(''); // hide the reader's ribbon while the page speaks
      ensureVoice();
      voiceLine!.replaceChildren();
      root.classList.add('lt-speaking');
      voiceWrap!.classList.add('show');
      lastSrcIndex = -1;

      const flies: { el: HTMLElement; srcIdx: number | null }[] = [];
      const ghosted: number[] = [];
      const words = line.split(' ').filter(Boolean);

      for (let wi = 0; wi < words.length; wi++) {
        if (wi > 0) {
          const gap = document.createElement('span');
          gap.className = 'lt-space';
          gap.textContent = ' ';
          voiceLine!.appendChild(gap);
        }
        for (const g of graphemes(words[wi]!)) {
          const ch = g.toLowerCase().replace(/ё/g, 'е');
          const el = document.createElement('span');
          el.className = 'lt-fly';
          el.textContent = g.toUpperCase();
          voiceLine!.appendChild(el);
          flies.push({ el, srcIdx: nextOccurrence(ch) });
        }
      }

      if (reduceMotion) {
        // Static legible reveal — no flight, just fade the line in.
        for (const f of flies) f.el.classList.add('in');
        await sleep(HOLD_MS);
      } else {
        // FLIP: measure each letter's final slot, offset it to its source
        // glyph, then release (staggered) so it flies home into the line.
        for (const f of flies) {
          const tr = f.el.getBoundingClientRect();
          const tcx = tr.left + tr.width / 2;
          const tcy = tr.top + tr.height / 2;
          let sx = tcx;
          let sy = tr.top - 56; // missing glyph: drop in from just above
          if (f.srcIdx != null) {
            const r = spans[f.srcIdx]!.getBoundingClientRect();
            sx = r.left + r.width / 2;
            sy = r.top + r.height / 2;
            spans[f.srcIdx]!.classList.add('ghost');
            ghosted.push(f.srcIdx);
          }
          f.el.style.setProperty('--dx', `${(sx - tcx).toFixed(1)}px`);
          f.el.style.setProperty('--dy', `${(sy - tcy).toFixed(1)}px`);
          f.el.classList.add('pre');
        }
        void voiceWrap!.offsetWidth; // reflow so .pre offsets take hold
        flies.forEach((f, i) => {
          f.el.style.transitionDelay = `${i * FLY_STAGGER}ms`;
          f.el.classList.remove('pre');
          f.el.classList.add('in');
        });
        await sleep((flies.length - 1) * FLY_STAGGER + FLY_TRAVEL + HOLD_MS);

        // Dissolve: letters drift back toward their source and fade out.
        flies.forEach((f, i) => {
          f.el.style.transitionDelay = `${i * 24}ms`;
          f.el.classList.remove('in');
          f.el.classList.add('pre', 'out');
        });
        await sleep((flies.length - 1) * 24 + 460);
      }

      for (const idx of ghosted) spans[idx]?.classList.remove('ghost');
      voiceWrap!.classList.remove('show');
      voiceLine!.replaceChildren();
      root.classList.remove('lt-speaking');

      clearSelection();
      speaking = false;
      after?.();
    };

    const clearSelection = () => {
      for (const i of selected) spans[i]!.classList.remove('lit');
      selected.clear();
      spelledIdx.length = 0;
      setRibbon('');
    };

    /* ── 8. Optional LLM flavour for wrong-answer deflections ──────────── */
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

    /* ── 9. Warp coupling (StarField exposes the hook; degrade if absent) ─ */
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

    /* ── 10. Ambient proximity breath (single rAF; ≤15 nearest get writes) ─ */
    let pointerX = -9999;
    let pointerY = -9999;
    let glowing: number[] = [];
    let raf = 0;

    const onPointerMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (geomDirty) recomputeCenters();

      for (const i of glowing) spans[i]?.style.setProperty('--g', '0');
      glowing = [];

      if (pointerX < -9000) return;

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
    // onPointerDown handles the correct-answer / wake transitions; maybeDeflect
    // runs right after so an over-long wrong spelling earns a coy line.
    const onPointerDownWrapped = (e: PointerEvent) => {
      onPointerDown(e);
      maybeDeflect();
    };
    root.addEventListener('pointerdown', onPointerDownWrapped);

    /* ── Cleanup ───────────────────────────────────────────────────────── */
    return () => {
      cancelAnimationFrame(raf);
      root.removeEventListener('pointerdown', onPointerDownWrapped);
      root.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', markDirty);
      window.removeEventListener('scroll', markDirty);
      root.classList.remove('lt-awake', 'lt-speaking');
      voiceWrap?.remove();
      ribbon?.remove();
    };
  }, [router]);

  return null;
}
