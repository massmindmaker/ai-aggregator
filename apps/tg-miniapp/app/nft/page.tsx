import Link from 'next/link';
import postgres from 'postgres';
import { BottomNav } from '@/components/BottomNav';

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

async function getCollections(): Promise<Collection[]> {
  try {
    const rows = (await sql`
      SELECT id::text, slug, name, description, image_url,
             price_nano_ton::text, minted_count, max_supply
      FROM nft_collections
      WHERE status = 'active'
        AND (max_supply IS NULL OR minted_count < max_supply)
      ORDER BY created_at DESC
    `) as unknown as Collection[];
    return rows;
  } catch (e) {
    console.error('nft list error:', e);
    return [];
  }
}

export default async function NftCatalogPage() {
  const collections = await getCollections();

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-badge">NFT</span>
          <h1 className="tma-title">Коллекции</h1>
          <p className="tma-subtitle">
            Минт через Startonus за TON. NFT приходит на ваш подключённый кошелёк.
          </p>
        </header>

        {collections.length === 0 ? (
          <section className="tma-card">
            <h2 className="tma-card-title">Пока пусто</h2>
            <p className="tma-card-text">
              Скоро здесь появятся коллекции. Загляните позже.
            </p>
          </section>
        ) : (
          <section className="tma-nft-grid">
            {collections.map((c) => {
              const sold = c.max_supply != null && c.minted_count >= c.max_supply;
              return (
                <Link key={c.id} href={`/nft/${c.slug}`} className="tma-nft-card">
                  {c.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.image_url}
                      alt={c.name}
                      className="tma-nft-image"
                      loading="lazy"
                    />
                  ) : (
                    <div className="tma-nft-image tma-nft-image--placeholder">
                      <span>NFT</span>
                    </div>
                  )}
                  <div className="tma-nft-body">
                    <h3 className="tma-nft-name">{c.name}</h3>
                    <div className="tma-nft-meta">
                      <span className="tma-nft-price">{nanoToTon(c.price_nano_ton)} TON</span>
                      {c.max_supply != null && (
                        <span className="tma-nft-supply">
                          {c.minted_count}/{c.max_supply}
                        </span>
                      )}
                    </div>
                    {sold && <div className="tma-nft-soldout">Sold out</div>}
                  </div>
                </Link>
              );
            })}
          </section>
        )}
      </main>
      <BottomNav />
    </>
  );
}
