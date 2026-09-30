/**
 * F-3 (security review) — PII/transborder transborder classification.
 *
 * Two things are asserted here:
 *   1. The pii-filter's slug→transborder decision is derived from
 *      FOREIGN_PROVIDERS (single source of truth), so the providers that were
 *      missing from the old hand-written regex (kie, fal, replicate, openrouter,
 *      huggingface, groq) are now classified as foreign.
 *   2. The residency policy shared by stored-media / stored-transcription is
 *      fail-closed: PII + default key policy ⇒ only RU-resident candidates
 *      survive, and an empty pool throws.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { slugLooksTransborder, setPiiResolveModel } from '../pii-filter';
import { FOREIGN_PROVIDERS, isForeignProvider } from '../transborderGate';
import {
  evaluateResidencyPolicy,
  StoredMediaPiiError,
} from '../../billing/stored-pii-residency';
import { detectPii } from '../../lib/pii';

const foreign = (ru_residency: boolean, id = 'c') => ({ id, ru_residency });

describe('F-3: slug → transborder classification', () => {
  afterEach(() => setPiiResolveModel(null));

  it.each(['kie', 'fal', 'replicate', 'openrouter', 'huggingface', 'groq', 'mistral', 'google'])(
    'classifies %s/… as transborder (was missing from the old regex)',
    (org) => {
      expect(slugLooksTransborder(`${org}/some-model`)).toBe(true);
      expect(isForeignProvider(`${org}/some-model`)).toBe(true);
    }
  );

  it.each(['openai', 'anthropic', 'together', 'cohere'])(
    'still classifies %s/… as transborder',
    (org) => {
      expect(slugLooksTransborder(`${org}/some-model`)).toBe(true);
    }
  );

  it.each(['yandex/yandexgpt-pro', 'sber/gigachat-pro', 'local/some-model'])(
    'does not classify RU-local %s as transborder',
    (slug) => {
      expect(slugLooksTransborder(slug)).toBe(false);
    }
  );

  it('bare org name without a slash is not a slug match', () => {
    expect(slugLooksTransborder('openai')).toBe(false);
  });

  it('every FOREIGN_PROVIDERS entry is matched by the derived pattern', () => {
    for (const org of FOREIGN_PROVIDERS) {
      expect(slugLooksTransborder(`${org}/x`)).toBe(true);
    }
  });
});

describe('F-3: stored media/transcription residency policy', () => {
  it('passes a clean prompt through untouched', () => {
    const text = 'a cat on a windowsill';
    const r = evaluateResidencyPolicy({
      policy: {},
      text,
      hits: detectPii(text),
      candidates: [foreign(false, 'kie')],
    });
    expect(r.restricted).toBe(false);
    expect(r.candidates).toHaveLength(1);
  });

  it('drops a non-RU candidate when the prompt carries PII and the key has the default policy', () => {
    const text = 'напиши письмо на user@example.com';
    const hits = detectPii(text);
    expect(hits.some((h) => h.blocking)).toBe(true);
    const r = evaluateResidencyPolicy({
      policy: {},
      text,
      hits,
      candidates: [foreign(false, 'kie'), foreign(true, 'ru')],
    });
    expect(r.restricted).toBe(true);
    expect(r.candidates.map((c) => c.id)).toEqual(['ru']);
  });

  it('throws when PII would leave the country and no RU candidate exists', () => {
    const text = 'ИНН 7707083893';
    expect(() =>
      evaluateResidencyPolicy({
        policy: {},
        text,
        hits: detectPii(text),
        candidates: [foreign(false, 'kie')],
      })
    ).toThrow(StoredMediaPiiError);
  });

  it('keeps the foreign candidate when the key explicitly allows transborder PII', () => {
    const text = 'user@example.com';
    const r = evaluateResidencyPolicy({
      policy: { allow_pii_transborder: true },
      text,
      hits: detectPii(text),
      candidates: [foreign(false, 'kie')],
    });
    expect(r.restricted).toBe(false);
    expect(r.candidates).toHaveLength(1);
  });

  it('treats unscannable PII-by-construction payloads (raw audio) as blocking', () => {
    expect(() =>
      evaluateResidencyPolicy({
        policy: {},
        text: '',
        hits: [],
        candidates: [foreign(false, 'groq')],
        piiByConstruction: true,
      })
    ).toThrow(StoredMediaPiiError);

    const r = evaluateResidencyPolicy({
      policy: { allow_pii_transborder: true },
      text: '',
      hits: [],
      candidates: [foreign(false, 'groq')],
      piiByConstruction: true,
    });
    expect(r.candidates).toHaveLength(1);
  });

  it('non-blocking ФИО hits alone do not restrict the pool', () => {
    const text = 'Иван Петров написал отчёт';
    const hits = detectPii(text);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.blocking)).toBe(true);
    const r = evaluateResidencyPolicy({
      policy: {},
      text,
      hits,
      candidates: [foreign(false, 'kie')],
    });
    expect(r.restricted).toBe(false);
  });
});