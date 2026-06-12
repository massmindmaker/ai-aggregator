import Link from 'next/link';
import { BottomNav } from '@/components/BottomNav';

// IA-миграция: массовый каталог скиллов снят. Скиллы — операторская поверхность
// (фаза 2, платный тариф). Обычные агенты идут с готовыми скиллами из коробки,
// отдельный install-UI массам не нужен. Честный stub вместо мёртвого каталога.
export default function SkillsPage() {
  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-eyebrow">Маркет</span>
          <h1 className="tma-title">Скиллы</h1>
        </header>

        <section className="tma-card">
          <div className="tma-row" style={{ gap: 8 }}>
            <h2 className="tma-card-title" style={{ margin: 0 }}>
              Каталог скиллов — для операторов
            </h2>
            <span className="tma-pill tma-pill--muted">◷ скоро</span>
          </div>
          <p className="tma-card-text" style={{ marginTop: 8 }}>
            Откроется в платном тарифе (фаза 2). Сейчас агенты идут с готовыми
            скиллами.
          </p>
          <Link href="/market" className="tma-btn" style={{ marginTop: 12 }}>
            ← К агентам
          </Link>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
