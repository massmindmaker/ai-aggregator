import Link from 'next/link';
import postgres from 'postgres';
import { notFound } from 'next/navigation';
import { BottomNav } from '@/components/BottomNav';
import { BuyButton } from './BuyButton';

export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface Collection {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  image_url: string | null;
  price_nano_ton: string;
  minted_count: number;
  max_supply: number | null;
  startonus_collection_id: string | null;
}

function nanoToTon(nano: string): string {
  try {
    const n = BigInt(nano);
    const int = n / 1_000_000_000n;
    const frac = n % 1_000_000_000n;
    if (frac === 0n) return int.toString();
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
    return `${int}.${fracStr}`;
  } catch {
    return '?';
  }
}

async function getCollection(slug: string): Promise<Collection | null> {
  try {
    const rows = (await sql`
      SELECT id::text, slug, name, description, image_url,
             price_nano_ton::text, minted_count, max_supply,
             startonus_collection_id
      FROM nft_collections
      WHERE slug = ${slug} AND status = 'active'
      LIMIT 1
    `) as unknown as Collection[];
    return rows[0] ?? null;
  } catch (e) {
    console.error('nft detail error:', e);
    return null;
  }
}

export default async function NftDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const c = await getCollection(slug);
  if (!c) notFound();

  const sold = c.max_supply != null && c.minted_count >= c.max_supply;
  const priceTon = nanoToTon(c.price_nano_ton);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href="/nft" className="tma-back-link">
          ← К коллекциям
        </Link>

        {c.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.image_url} alt={c.name} className="tma-nft-hero" loading="eager" />
        ) : (
          <div className="tma-nft-hero tma-nft-image--placeholder">
            <span>NFT</span>
          </div>
        )}

        <header className="tma-header">
          <h1 className="tma-title">{c.name}</h1>
          {c.description && <p className="tma-subtitle">{c.description}</p>}
        </header>

        <section className="tma-card">
          <div className="tma-row">
            <span className="tma-card-text">Цена</span>
            <span className="tma-price-strong">{priceTon} TON</span>
          </div>
          {c.max_supply != null && (
            <div className="tma-row">
              <span className="tma-card-text">Тираж</span>
              <span className="tma-card-text">
                {c.minted_count} / {c.max_supply}
              </span>
            </div>
          )}
        </section>

        {sold ? (
          <section className="tma-card">
            <p className="tma-card-text">Все экземпляры выпущены.</p>
          </section>
        ) : (
          <BuyButton collectionSlug={c.slug} priceTon={priceTon} />
        )}

        <section className="tma-card">
          <h2 className="tma-card-title">Как это работает</h2>
          <ol className="tma-list">
            <li>Подключите TON-кошелёк через TON Connect.</li>
            <li>Подтвердите транзакцию — депозит в minter Startonus.</li>
            <li>NFT приходит на ваш кошелёк через 1–3 минуты после on-chain подтверждения.</li>
          </ol>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
