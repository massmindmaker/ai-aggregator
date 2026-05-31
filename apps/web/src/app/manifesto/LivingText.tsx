'use client';

/**
 * LivingText — the «ПРОСНИСЬ» mechanic of the Chronicle.
 *
 * The manifesto SPEAKS BACK with its OWN body text. Letters breathe amber near
 * the cursor and turn touchable. The reader spells the WAKE WORD «ПРОСНИСЬ» by
 * clicking letters of the prose (a quiet «лента» echoes their spelling). The
 * presence then wakes: a run of REAL prose letters — in the line where the
 * reader was typing and the lines below — light up and ROLL around their own
 * axis (split-flap), re-forming into the reply «Я НЕ СПЛЮ» right inside the
 * text, then settle back to the original words. A fixed three-question lore
 * quest follows; the climax warps to the secret chamber.
 *
 * Design constraints honoured here:
 *  - No React re-render over thousands of spans: we wrap glyphs once via a
 *    DocumentFragment and thereafter mutate classList / textContent.
 *  - One rAF loop, one pointer listener (delegated on the prose root).
 *  - Cyrillic-safe grapheme splitting via Intl.Segmenter (graceful fallback).
 *  - Full prefers-reduced-motion path (no spin — letters just resolve).
 *  - The body text is ALWAYS restored after the presence finishes a line.
 *  - Deterministic puzzle: wake word + the 3 Q&A are fixed (dialogue.ts).
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
const ROLL_GLYPHS = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ'; // reel chars (letters only)
const SLOT_STAGGER = 65; // ms between consecutive letters starting to roll
const ROLL_TICK = 45; // ms per glyph flip while a letter rolls
const ROLL_TICKS = 7; // glyphs a letter rolls through before it settles
const HOLD_MS = 1500; // ms the assembled word lingers before the text restores
const ANSWER_GAP = 6; // letters skipped between consecutive answers (flow down)
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
        span.classList.remove('lit', 'rolling', 'settled');
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

    // Document-ordered sequence of letter-span indices + reverse lookup. The
    // presence rewrites a CONTIGUOUS run of these into its reply, in place.
    const letterSeq: number[] = [];
    const seqPos = new Map<number, number>();
    for (let i = 0; i < spans.length; i++) {
      if (isLetter(spans[i]!.textContent ?? '')) {
        seqPos.set(i, letterSeq.length);
        letterSeq.push(i);
      }
    }

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
    let speakCursor = 0; // position in letterSeq where the next reply rewrites

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
        // Accumulate the click tail; wake when it spells the FULL «ПРОСНИСЬ».
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
     * without matching, the next non-matching click triggers a deflection. */
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

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /* ── 7. Roll ONE real prose glyph: light it, spin it, settle on `ch` ── */
    const rollSpan = (span: HTMLElement, target: string, delay: number) =>
      new Promise<void>((resolve) => {
        if (reduceMotion) {
          span.classList.add('lit', 'settled');
          span.textContent = target;
          resolve();
          return;
        }
        window.setTimeout(() => {
          let n = 0;
          span.classList.add('rolling');
          const id = window.setInterval(() => {
            n++;
            if (n >= ROLL_TICKS) {
              window.clearInterval(id);
              span.textContent = target;
              span.classList.remove('rolling');
              span.classList.add('lit', 'settled');
              resolve();
            } else {
              span.textContent =
                ROLL_GLYPHS[(Math.random() * ROLL_GLYPHS.length) | 0]!;
            }
          }, ROLL_TICK);
        }, delay);
      });

    /* ── 7b. The presence speaks THROUGH the body text ──────────────────
     * Rewrite a contiguous run of real prose letters into `line`: each rolls
     * into place, the word holds, then every glyph restores to its original.
     * Anchored where the reader just typed; flows into the lines below. */
    const speak = async (line: string, after?: () => void) => {
      speaking = true;
      setRibbon('');

      // Anchor just after the reader's most recent click (the line they typed
      // in); if they have no live selection, continue down from where we were.
      if (selected.size > 0) {
        let maxSel = -1;
        for (const i of selected) if (i > maxSel) maxSel = i;
        let p = seqPos.get(maxSel);
        if (p == null) {
          p = letterSeq.findIndex((idx) => idx > maxSel);
          if (p < 0) p = 0;
        }
        speakCursor = Math.min(p + 2, Math.max(0, letterSeq.length - 1));
      }

      clearSelection(); // the reader's lit letters fade before the page answers

      const touched: { span: HTMLElement; orig: string }[] = [];
      const rolls: Promise<void>[] = [];
      let firstSpan: HTMLElement | null = null;
      let slot = 0;

      for (const g of Array.from(line)) {
        if (letterSeq.length === 0) break;
        if (speakCursor >= letterSeq.length) speakCursor = 0; // wrap around
        const span = spans[letterSeq[speakCursor++]!]!;
        touched.push({ span, orig: span.textContent ?? '' });
        if (!firstSpan) firstSpan = span;
        if (g === ' ') {
          span.classList.remove('lit');
          span.textContent = ' '; // a quiet gap between the answer's words
          continue;
        }
        rolls.push(rollSpan(span, g.toUpperCase(), slot * SLOT_STAGGER));
        slot++;
      }

      // bring the forming answer into view (it may start below the fold)
      if (firstSpan && !reduceMotion) {
        const r = firstSpan.getBoundingClientRect();
        if (r.top < 64 || r.bottom > window.innerHeight - 64) {
          firstSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      await Promise.all(rolls);
      await sleep(HOLD_MS);

      // restore the manifesto to its original words
      for (const { span, orig } of touched) {
        span.classList.remove('lit', 'rolling', 'settled');
        span.style.removeProperty('--g');
        span.textContent = orig;
      }
      geomDirty = true;

      // leave a gap so the next reply flows into the following lines
      speakCursor = Math.min(speakCursor + ANSWER_GAP, letterSeq.length);

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
      if (speaking) return; // don't fight the presence for these glyphs
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
      ribbon?.remove();
    };
  }, [router]);

  return null;
}
