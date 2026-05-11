import postgres from 'postgres';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BottomNav } from '@/components/BottomNav';
import { UseInAgentButton } from './UseInAgentButton';

export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Model {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  image_url: string | null;
  type: string | null;
  tags: string[] | null;
}

async function getModel(slug: string): Promise<Model | null> {
  try {
    const rows = (await sql`
      SELECT id::text, slug,
             COALESCE(display_name, slug) AS name,
             description, image_url, type, tags
      FROM models
      WHERE slug = ${slug}
      LIMIT 1
    `) as unknown as Model[];
    return rows[0] ?? null;
  } catch (e) {
    console.error('marketplace detail error:', e);
    return null;
  }
}

export default async function MarketDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const model = await getModel(params.slug);
  if (!model) notFound();

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href="/market" className="tma-back-link">
          ← Назад
        </Link>

        <header className="tma-header">
          <span className="tma-badge">{model.type?.toUpperCase() ?? 'MODEL'}</span>
          <h1 className="tma-title">{model.name}</h1>
          <p className="tma-subtitle" style={{ wordBreak: 'break-all' }}>
            {model.slug}
          </p>
        </header>

        {model.image_url && (
          <div style={{ marginBottom: 16 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={model.image_url}
              alt={model.name}
              style={{
                width: '100%',
                aspectRatio: '1/1',
                objectFit: 'cover',
                borderRadius: 12,
                border: '1px solid var(--line)',
              }}
            />
          </div>
        )}

        {model.description && (
          <section className="tma-card">
            <h2 className="tma-card-title">Описание</h2>
            <p className="tma-card-text">{model.description}</p>
          </section>
        )}

        {model.tags && model.tags.length > 0 && (
          <section className="tma-card">
            <h2 className="tma-card-title">Теги</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {model.tags.map((t) => (
                <span
                  key={t}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--line)',
                    fontSize: 12,
                    color: 'var(--ink)',
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </section>
        )}

        <UseInAgentButton slug={model.slug} />
      </main>
      <BottomNav />
    </>
  );
}
