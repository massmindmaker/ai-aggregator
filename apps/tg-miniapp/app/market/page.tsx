import postgres from 'postgres';
import Link from 'next/link';
import { BottomNav } from '@/components/BottomNav';
import { CatalogNav } from '@/components/CatalogNav';

export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Model {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  image_url: string | null;
  type: string | null;
}

async function getModels(): Promise<Model[]> {
  try {
    const rows = (await sql`
      SELECT id::text, slug,
             COALESCE(display_name, slug) AS name,
             description, image_url, type
      FROM models
      WHERE enabled = true
        AND status IN ('live', 'active', 'published')
      ORDER BY created_at DESC
      LIMIT 50
    `) as unknown as Model[];
    return rows;
  } catch (e) {
    console.error('marketplace list error:', e);
    return [];
  }
}

export default async function MarketPage() {
  const models = await getModels();

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-eyebrow">Каталог</span>
          <h1 className="tma-title">Модели</h1>
          <p className="tma-subtitle">Подключите модель к агенту в один клик.</p>
        </header>

        <CatalogNav active="models" />

        {models.length === 0 ? (
          <section className="tma-card">
            <h2 className="tma-card-title">Каталог пуст</h2>
            <p className="tma-card-text">Скоро здесь появятся модели.</p>
          </section>
        ) : (
          <section className="tma-nft-grid">
            {models.map((m) => (
              <Link key={m.id} href={`/market/${m.slug}`} className="tma-nft-card">
                {m.image_url ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={m.image_url}
                    alt={m.name}
                    className="tma-nft-image"
                    loading="lazy"
                  />
                ) : (
                  <div className="tma-nft-image tma-nft-image--placeholder">
                    <span>{m.type?.toUpperCase().slice(0, 3) ?? 'AI'}</span>
                  </div>
                )}
                <div className="tma-nft-body">
                  <h3 className="tma-nft-name">{m.name}</h3>
                  <div className="tma-nft-meta">
                    <span className="tma-nft-supply">{m.type ?? 'model'}</span>
                  </div>
                </div>
              </Link>
            ))}
          </section>
        )}
      </main>
      <BottomNav />
    </>
  );
}
