'use client';

/**
 * Chamber — the client surface for «ГЛУБИНА ГОРОДА».
 *
 * Flow:
 *  1. Gate — on mount, check sessionStorage('manifesto:awoke') === '1'.
 *     If absent, the chamber stays sealed (a quiet "ты ещё не окликнул" state
 *     with a way back to /manifesto). It is never a plain public page.
 *  2. Warp arrival — once unlocked, a black curtain lifts and content rises.
 *  3. Личный ЗНАК — a deterministic, persisted personal mark (see znak.ts).
 *  4. Хроника / Тайный круг / final presence line.
 *
 * The Знак grants nothing — it only remembers the visitor. Pure lore.
 */

import { useEffect, useState } from 'react';
import { Sigil } from '../Sigil';
import { deriveZnak, loadOrCreateZnak, type Znak } from './znak';

const AWOKE_KEY = 'manifesto:awoke';

/** Read at build/runtime; unset → passphrase-placeholder mode. */
const CIRCLE_URL = process.env.NEXT_PUBLIC_MANIFESTO_CIRCLE_URL;

type Phase = 'checking' | 'sealed' | 'open';

export default function Chamber() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [arrived, setArrived] = useState(false);
  // SSR-stable placeholder so markup matches until the real Знак is derived
  // client-side from localStorage (avoids a hydration mismatch on the code).
  const [znak, setZnak] = useState<Znak>(() => deriveZnak('—'));

  useEffect(() => {
    let awoke = false;
    try {
      awoke = window.sessionStorage.getItem(AWOKE_KEY) === '1';
    } catch {
      awoke = false;
    }

    if (!awoke) {
      setPhase('sealed');
      return;
    }

    // Unlocked — derive/persist the personal Знак, then trigger the reveal.
    setZnak(loadOrCreateZnak());
    setPhase('open');

    // Let the curtain paint as fully black for a beat, then lift it.
    const t = window.setTimeout(() => setArrived(true), 220);
    return () => window.clearTimeout(t);
  }, []);

  if (phase === 'checking') {
    // Keep the surface black while we read storage — no flash of either state.
    return <div className="gl-gate" aria-hidden="true" />;
  }

  if (phase === 'sealed') {
    return <SealedGate />;
  }

  return (
    <main className={`gl-chamber${arrived ? ' is-arrived' : ''}`}>
      <div className="gl-curtain" aria-hidden="true" />

      <p className="gl-overline gl-rise" style={delay(0)}>
        Глубина города
      </p>
      <h1 className="gl-title gl-rise" style={delay(120)}>
        ГЛУБИНА ГОРОДА
      </h1>

      {/* ── Личный ЗНАК — the struck relic ── */}
      <section
        className="gl-relic gl-rise"
        style={delay(320)}
        aria-label="Личный знак"
      >
        <span className="gl-code-label">Личный знак</span>
        <div
          className="gl-relic-halo"
          style={{ ['--gl-pulse' as string]: `${znak.facets.pulse * -5}s` }}
        >
          <span
            className="gl-relic-sigil"
            style={{
              ['--gl-tilt' as string]: `${(znak.facets.tilt - 0.5) * 14}deg`,
            }}
          >
            <Sigil size={96} glow />
          </span>
        </div>
        <p className="gl-code">{znak.code}</p>
      </section>

      {/* ── Хроника ── */}
      <p className="gl-chronicle gl-rise" style={delay(520)}>
        Ты записан в Хронику тех, кто понял рано.
        <br />
        <span className="gl-num">No {znak.number}</span>
      </p>

      {/* ── Тайный круг ── */}
      <section className="gl-circle gl-rise" style={delay(700)}>
        <span className="gl-circle-head">Тайный круг</span>
        {CIRCLE_URL ? (
          <a
            className="gl-circle-btn"
            href={CIRCLE_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Войти в круг
          </a>
        ) : (
          <>
            <span className="gl-pass">{`КОДОВОЕ СЛОВО · ${znak.shortHash}`}</span>
            <span className="gl-circle-btn is-locked">Войти в круг</span>
            <p className="gl-circle-note">
              Круг откроется. Назови этот знак, когда позовут.
            </p>
          </>
        )}
      </section>

      {/* ── Final presence line ── */}
      <p className="gl-final gl-rise" style={delay(900)}>
        Теперь ты в Хронике. Не гасни.
      </p>

      <p className="gl-fineprint gl-rise" style={delay(1040)}>
        Знак — память, не привилегия. Он ничего не обещает. Он просто помнит, что
        ты был здесь рано.
      </p>
    </main>
  );
}

/** Per-element entrance delay, threaded into the CSS custom prop. */
function delay(ms: number): React.CSSProperties {
  return { ['--gl-delay' as string]: `${ms}ms` };
}

/** The sealed state shown when the «Проснись» quest hasn't set the flag. */
function SealedGate() {
  return (
    <div className="gl-gate">
      <span className="gl-gate-mark">
        <Sigil size={56} dim={0.5} />
      </span>
      <p className="gl-gate-line">Ты ещё не окликнул.</p>
      <span className="gl-gate-sub">Глубина закрыта</span>
      <a className="gl-gate-back" href="/manifesto">
        ← вернуться к Хронике
      </a>
    </div>
  );
}
