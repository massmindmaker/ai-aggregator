import postgres from 'postgres';
import { notFound } from 'next/navigation';
import { BottomNav } from '@/components/BottomNav';
import { BackLink } from '@/components/BackLink';
import { fmtCredits } from '@/lib/credits';
import { TransferPanel } from '../TransferPanel';

export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

// PUBLIC acquirer offer page — the delivery surface for gift/sale (CONTEXT Q#4).
// The owner shares /tg/agents/[id]/offer; the recipient/buyer opens it here.
// It is UNGUARDED to VIEW (the acquirer is not the owner; the owner-guarded detail
// GET 404s them) and surfaces ONLY non-sensitive fields — same allow-list as the
// public transfer-offer route (16-02). No persona prompt, no keys, no owner id.
// White-label + crypto-only: never the minter brand, never rubles.

interface Offer {
  id: string;
  name: string;
  /** short persona/role preview (truncated description) — never the raw persona prompt */
  role: string;
  transfer_price_credits: string | null;
  status: string;
}

async function getOffer(id: string): Promise<Offer | null> {
  try {
    const rows = (await sql`
      SELECT id::text, name,
             LEFT(COALESCE(description, ''), 280) AS role,
             transfer_price_credits::text AS transfer_price_credits,
             status
      FROM agents
      WHERE id = ${id}::uuid
        AND transferable = TRUE
        AND status != 'deleted'
      LIMIT 1
    `) as unknown as Offer[];
    return rows[0] ?? null;
  } catch (e) {
    // Bad UUID / DB error → opaque miss (no existence oracle).
    console.error('agent offer error:', e);
    return null;
  }
}

export default async function AgentOfferPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const offer = await getOffer(id);
  if (!offer) notFound();

  const mintFeeTon = process.env.AGENT_MINT_FEE_TON ?? '0.1';
  const isGift = offer.transfer_price_credits == null;

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <BackLink href="/market">← К маркету</BackLink>

        <header className="tma-header">
          <h1 className="tma-title">{offer.name}</h1>
          {offer.role && <p className="tma-subtitle">{offer.role}</p>}
        </header>

        <section className="tma-card">
          <div className="tma-row">
            <span className="tma-card-text">{isGift ? 'Передаётся' : 'Цена'}</span>
            <span className="tma-price-strong">
              {isGift ? 'в дар' : <><span className="tma-mono">{fmtCredits(offer.transfer_price_credits)}</span> кр</>}
            </span>
          </div>
          <div className="tma-row">
            <span className="tma-card-text">Минт NFT</span>
            <span className="tma-card-text">
              ~<span className="tma-mono">{mintFeeTon}</span> TON
            </span>
          </div>
        </section>

        <section className="tma-card">
          <h2 className="tma-card-title">Что переходит</h2>
          <p className="tma-card-text tma-text-small" style={{ marginBottom: 8 }}>
            Передача — это <strong>перемещение одного экземпляра</strong>: агент пропадёт
            у владельца и появится у вас. Это <strong>не копия</strong> и{' '}
            <strong>не аренда</strong>.
          </p>
          <ul className="tma-list">
            <li>Переезжают: персона, настройки, скиллы.</li>
            <li>Личная история и чаты стираются.</li>
            <li>Перенос обученной памяти появится позже (D-5).</li>
          </ul>
        </section>

        <TransferPanel
          agentId={offer.id}
          isOwner={false}
          transferable={true}
          transferPriceCredits={offer.transfer_price_credits ?? null}
          agentName={offer.name}
          agentRole={offer.role}
          mintFeeTon={mintFeeTon}
        />
      </main>
      <BottomNav />
    </>
  );
}
