import type { Metadata } from 'next';
import StarField from './StarField';
import Reveal from './Reveal';
import LivingText from './LivingText';
import './manifesto.css';

export const metadata: Metadata = {
  title: 'Хроника — Манифест AI-Aggregator',
  description:
    'Видение. История о будущем, которого ещё нет — но которое уже началось. Кто поймёт — тот поймёт.',
  openGraph: {
    title: 'Хроника — Манифест AI-Aggregator',
    description:
      'Город, у которого нет хозяина наверху, потому что хозяева — внутри. Кто поймёт — тот поймёт.',
    type: 'article',
  },
  robots: { index: true, follow: true },
};

/**
 * The manifesto is its own cinematic surface: a dedicated dark reel that does
 * NOT inherit the product navbar/footer and is not bound to the app's
 * light/dark toggle. The atmosphere layers (star-field + grain) and the single
 * scroll-reveal observer live here so the page itself can stay a server
 * component built from the real manifesto text.
 */
export default function ManifestoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="manifesto-root dark">
      <StarField />
      <div className="manifesto-grain" aria-hidden="true" />
      <div className="manifesto-content">{children}</div>
      <Reveal />
      <LivingText />
    </div>
  );
}
