'use client';

/**
 * Reveal — a single IntersectionObserver shared across the whole page that
 * toggles `.is-in` on any `.m-reveal` (and `.m-rule`) element once it scrolls
 * into view. Kept as one observer for the document rather than one component
 * per block, so server components stay server components and we ship almost
 * no client JS. Reduced-motion users get everything revealed immediately
 * (the CSS already neutralises the transitions).
 */

import { useEffect } from 'react';

export default function Reveal() {
  useEffect(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('.m-reveal, .m-rule'),
    );
    if (els.length === 0) return;

    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}
