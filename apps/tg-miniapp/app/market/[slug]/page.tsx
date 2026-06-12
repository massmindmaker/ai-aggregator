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
  context_window: string | null;
  price_in_1m: string | null;
  price_out_1m: string | null;
  price_image: string | null;
}

// Real data only (D16): prices come from model_upstreams (the gateway's billing
// source), context from models.metadata. The upstream itself is NEVER exposed
// (white-label) — only the resulting AIAG price (base × markup) in credits.
// UNIT: price_per_1k is stored in RUB (web-product seeds 0004/0006; verified
// against real model prices). Credit = US cent → convert ×100/USD_TO_RUB.
async function getModel(slug: string): Promise<Model | null> {
  const rub = Number(process.env.USD_TO_RUB ?? '90');
  try {
    const rows = (await sql`
      SELECT m.id::text, m.slug,
             COALESCE(m.display_name, m.slug) AS name,
             m.description, m.image_url, m.type, m.tags,
             NULLIF(m.metadata->>'context_window', '') AS context_window,
             p.price_in_1m, p.price_out_1m, p.price_image
      FROM models m
      LEFT JOIN LATERAL (
        SELECT ROUND(mu.price_per_1k_input  * mu.markup * 1000 * 100 / ${rub}, 2)::text AS price_in_1m,
               ROUND(mu.price_per_1k_output * mu.markup * 1000 * 100 / ${rub}, 2)::text AS price_out_1m,
               ROUND(mu.price_per_image * mu.markup * 100 / ${rub}, 2)::text AS price_image
        FROM model_upstreams mu
        WHERE mu.model_id = m.id AND mu.enabled = true
        ORDER BY mu.price_per_1k_input ASC, mu.created_at ASC
        LIMIT 1
      ) p ON true
      WHERE m.slug = ${slug}
      LIMIT 1
    `) as unknown as Model[];
    return rows[0] ?? null;
  } catch (e) {
    console.error('marketplace detail error:', e);
    return null;
  }
}

// Format a positive credit amount for display; null hides the row (no fake zeros).
function fmtCredits(s: string | null): string | null {
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function fmtTokens(s: string | null): string | null {
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString('ru-RU');
}

export default async function MarketDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const model = await getModel(params.slug);
  if (!model) notFound();

  const priceIn = fmtCredits(model.price_in_1m);
  const priceOut = fmtCredits(model.price_out_1m);
  const priceImage = fmtCredits(model.price_image);
  const contextTokens = fmtTokens(model.context_window);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href="/market" className="tma-back-link">
          ← К маркету
        </Link>

        <header className="tma-header">
          <span className="tma-eyebrow">Модель</span>
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

        {/* Only REAL billing data (D16) — a row without data is hidden, never
            replaced by a decorative metric. All numerics in mono. */}
        {(priceIn || priceOut || priceImage || contextTokens) && (
          <section className="tma-card">
            <h2 className="tma-card-title">Цена и контекст</h2>
            {priceIn && (
              <div className="tma-row">
                <span className="tma-card-text">Вход</span>
                <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {priceIn} кр / 1M токенов
                </span>
              </div>
            )}
            {priceOut && (
              <div className="tma-row" style={{ marginTop: 8 }}>
                <span className="tma-card-text">Выход</span>
                <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {priceOut} кр / 1M токенов
                </span>
              </div>
            )}
            {priceImage && (
              <div className="tma-row" style={{ marginTop: 8 }}>
                <span className="tma-card-text">Изображение</span>
                <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {priceImage} кр / шт
                </span>
              </div>
            )}
            {contextTokens && (
              <div className="tma-row" style={{ marginTop: 8 }}>
                <span className="tma-card-text">Контекст</span>
                <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {contextTokens} токенов
                </span>
              </div>
            )}
            <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
              Цены в кредитах, уже с учётом комиссии. Со своим ключом провайдера
              комиссии нет.
            </p>
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
