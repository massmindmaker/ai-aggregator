import type { Metadata } from 'next';
import Chamber from './Chamber';
import './глубина.css';

/**
 * /manifesto/глубина — «ГЛУБИНА ГОРОДА».
 *
 * The secret chamber the warp-jump lands on. Reachable only after solving the
 * «Проснись» dialogue-quest, which sets sessionStorage('manifesto:awoke','1')
 * and navigates here. Not a public page: the client gate seals it otherwise.
 *
 * Inherits the cinematic dark surface (StarField, grain, palette, fonts) from
 * the shared manifesto layout — this route only adds its own scoped styles.
 */

export const metadata: Metadata = {
  title: 'Глубина города — Хроника AI-Aggregator',
  description:
    'Камера для тех, кто понял рано. Личный знак. Хроника. Тайный круг.',
  // Hidden lore surface — keep it out of search indexes.
  robots: { index: false, follow: false },
};

export default function GlubinaPage() {
  return <Chamber />;
}
