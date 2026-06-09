import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { generateInvoice, tonToNano } from '@aiag/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sale-price sanity ceiling (US cents) = $1000 — mirrors the rent route. The price
// is read from the agent's STORED transfer_price_credits, never from client input.
const MAX_PRICE_CREDITS = 100_000;

interface Body {
  recipient_address: string;
}

interface AgentRow {
  seller_id: string;
  transferable: boolean;
  price: string | null;
  status: string | null;
  name: string | null;
  description: string | null;
  model_slug: string | null;
}

/**
 * POST /api/tma/agents/:id/transfer — KEYSTONE transfer/sale INITIATE (Wave-3).
 *
 * The acquirer (recipient) initiates: we insert a `pending` transfer_charges row
 * and call the (rewritten, plan 16-05) Startonus `generateInvoice` to lazily mint a
 * TEP-62 NFT item — into the ONE shared "Агенты" collection — directly onto the
 * ACQUIRER's TON wallet. The acquirer pays the mint fee in TON via TON Connect.
 *
 * LOCKED DECISION (CONTEXT.md open Q#2): the recipient/acquirer pays the mint fee for
 * BOTH a gift and a sale. The caller who initiates IS the mint-payer in every case;
 * there is no donor-paid path in MVP. The only difference between gift and sale is
 * amount_credits (0 vs the stored price).
 *
 * Ownership does NOT move here. No debit/credit, no history wipe. Those happen ONLY
 * on the Startonus webhook confirm (…/agents/transfer/webhook). White-label: the
 * minter brand never appears in any user-facing response.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // The caller IS the acquirer (recipient + mint-payer). Their id is owner.tgId.
  const buyerId = req.headers.get('x-tma-user-id');
  if (!buyerId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const recipient_address = body.recipient_address;
  if (!recipient_address || typeof recipient_address !== 'string') {
    return NextResponse.json({ error: 'recipient_address_required' }, { status: 400 });
  }

  // 1) Load the agent + its transfer state. Read the STORED price — never client input.
  //    NB (schema): the agents table has name/description/model_slug; there is no
  //    `role` or `avatar`/`portrait` column — use `description` for the card line and
  //    a deterministic monogram URL on OUR domain for the image (white-label).
  const rows = (await sql`
    SELECT tg_user_id::text AS seller_id, transferable,
           transfer_price_credits::text AS price, status,
           name, description, model_slug
    FROM agents WHERE id = ${params.id}::uuid LIMIT 1
  `) as unknown as AgentRow[];
  const a = rows[0];
  if (!a || a.status === 'deleted') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!a.transferable) {
    return NextResponse.json({ error: 'not_transferable' }, { status: 409 });
  }
  const sellerId = a.seller_id;

  // 2) SELF-DEAL GUARD (rent precedent): a user cannot acquire their own agent.
  if (buyerId === sellerId) {
    return NextResponse.json({ error: 'self_deal' }, { status: 403 });
  }

  // 3) Determine kind + amount. NULL stored price → gift (amount 0); else → sale.
  let kind: 'gift' | 'sale';
  let amountCredits: number;
  if (a.price === null) {
    kind = 'gift';
    amountCredits = 0;
  } else {
    const price = Number(a.price);
    if (!Number.isInteger(price) || price <= 0 || price > MAX_PRICE_CREDITS) {
      return NextResponse.json({ error: 'invalid_price' }, { status: 400 });
    }
    kind = 'sale';
    amountCredits = price;
  }

  // 4) PENDING idempotency — MVP commits to the 409 path (no reuse/re-derive branch).
  //    A pending charge is cleared either by webhook settle (→ 'settled') or by a
  //    finalize rollback that marks it 'failed' (webhook WARNING-1 fix) — so the
  //    buyer is never permanently locked out.
  const pend = (await sql`
    SELECT id::text FROM transfer_charges
    WHERE agent_id = ${params.id}::uuid AND status = 'pending' LIMIT 1
  `) as unknown as Array<{ id: string }>;
  if (pend.length > 0) {
    return NextResponse.json({ error: 'transfer_pending' }, { status: 409 });
  }

  // 5) Insert the pending charge (the webhook idempotency anchor + ledger ref_id).
  const ins = (await sql`
    INSERT INTO transfer_charges (
      agent_id, buyer_tg_user_id, seller_tg_user_id, amount_credits, kind, status, created_at
    )
    VALUES (
      ${params.id}::uuid, ${buyerId}::bigint, ${sellerId}::bigint,
      ${amountCredits}::bigint, ${kind}, 'pending', NOW()
    )
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;
  const chargeId = ins[0]?.id;
  if (!chargeId) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  // 6) Startonus invoice — acquirer-paid lazy mint into the ONE shared collection,
  //    onto the acquirer's wallet. Read the THREE current env vars (secret +
  //    collection address + mint template id). Any unset → 503 + mark charge failed.
  const secret = process.env.STARTONUS_SECRET;
  const collectionAddress = process.env.STARTONUS_AGENT_COLLECTION_ADDRESS;
  const mintTemplateId = process.env.STARTONUS_AGENT_MINT_TEMPLATE_ID;
  if (!secret || !collectionAddress || !mintTemplateId) {
    await sql`UPDATE transfer_charges SET status='failed' WHERE id = ${chargeId}::uuid`;
    return NextResponse.json({ error: 'minter_not_configured' }, { status: 503 });
  }

  const publicBase = process.env.PUBLIC_BASE_URL ?? 'https://app.ai-aggregator.ru';
  const callbackUrl = `${publicBase}/tg/api/tma/agents/transfer/webhook`;
  // WHITE-LABEL: nftData.image MUST be a URL on OUR domain/CDN — never an upstream
  // provider image host. No portrait column exists yet → deterministic monogram on
  // our own domain.
  const portraitUrl = `${publicBase}/tg/og/agent/${params.id}.png`;

  try {
    const invoice = await generateInvoice({
      templateId: Number(mintTemplateId),
      address: collectionAddress,
      secret,
      owner: { tgId: Number(buyerId), wallet: recipient_address },
      nftPrice: tonToNano(process.env.STARTONUS_AGENT_MINT_TON ?? '0.1'),
      nftData: {
        name: a.name ?? 'Agent',
        description: (a.description ?? '').slice(0, 200),
        image: portraitUrl,
        attributes: [
          ...(a.model_slug ? [{ type: 'model', value: a.model_slug }] : []),
        ],
      },
      userData: chargeId,
      callbackUrl,
    });

    await sql`
      UPDATE transfer_charges SET startonus_invoice_id = ${invoice.id}
      WHERE id = ${chargeId}::uuid
    `;

    return NextResponse.json({
      transfer_id: chargeId,
      kind,
      charged_credits: amountCredits,
      transaction: {
        validUntil: invoice.validUntil,
        messages: [
          {
            address: invoice.to,
            amount: invoice.value,
            payload: invoice.payload,
          },
        ],
      },
    });
  } catch (e) {
    // Keep the raw cause server-side; the user-facing label is generic (white-label).
    console.error('transfer invoice failed:', e);
    await sql`UPDATE transfer_charges SET status='failed' WHERE id = ${chargeId}::uuid`;
    return NextResponse.json({ error: 'minter_unavailable' }, { status: 502 });
  }
}
