import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * Startonus mint callback payload (rewritten client shape, plan 16-05).
 * `userData` = our transfer_charges.id UUID; `item` = the minted TEP-62 item
 * contract address (stored on the existing agents.nft_address, migration 0039).
 */
interface TransferCallback {
  success?: boolean;
  /** Our transfer_charges.id UUID */
  userData?: string;
  /** Startonus event: invoice_paid | paid | minted | failed | error */
  event?: string;
  /** TON tx hash */
  txHash?: string;
  /** Legacy minted-address field (fallback for `item`) */
  nftAddress?: string;
  /** Minted NFT item contract address (preferred) */
  item?: string;
  /** Error message if event=failed */
  error?: string;
}

interface ChargeRow {
  id: string;
  agent_id: string;
  buyer_id: string;
  seller_id: string;
  amount: string;
  kind: string;
  status: string;
}

/**
 * POST /api/tma/agents/transfer/webhook — KEYSTONE transfer FINALIZER (Wave-3).
 *
 * Startonus does NOT sign webhooks. Defence in depth (T-16-09):
 *   1. the userData is an UNGUESSABLE transfer_charges UUID — an attacker cannot
 *      forge a real pending charge id;
 *   2. nginx IP-allowlist for Startonus is a DEPLOY task (see SUMMARY user_setup);
 *   3. the guarded ownership UPDATE only moves an agent still owned by the recorded
 *      seller (a replayed webhook after the move gets 0 rows → rollback).
 *
 * On a 'minted' event, in ONE sql.begin we atomically: move ownership (guarded on
 * the old owner), wipe personal history (agent_runs), strip secrets the new owner
 * must not inherit, and — for a SALE — debit the buyer + credit the seller 100%
 * (AIAG 0%, exactly like author-rent) with two equal-and-opposite ledger rows under
 * one ref_id. Idempotent on transfer_charges.status + ON CONFLICT (ref_kind, ref_id,
 * kind). White-label: the minter brand never appears in any response.
 */
export async function POST(req: NextRequest) {
  // T-16-09: Startonus does NOT sign webhooks and publishes no fixed egress IPs.
  // We build the callbackUrl ourselves, so we embed a shared secret (?token=…) and
  // verify it constant-time BEFORE any DB work. This closes the self-settle hole
  // (the charge UUID is returned to the acquirer, so it is not a secret). If the
  // secret is unconfigured the check is skipped (fail-open only when unset).
  const WEBHOOK_SECRET = process.env.TRANSFER_WEBHOOK_SECRET;
  if (WEBHOOK_SECRET) {
    const got = Buffer.from(req.nextUrl.searchParams.get('token') ?? '');
    const want = Buffer.from(WEBHOOK_SECRET);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let body: TransferCallback;
  try {
    body = (await req.json()) as TransferCallback;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { userData, event, txHash, nftAddress, item } = body;
  if (!userData || !event) {
    return NextResponse.json({ error: 'missing_required' }, { status: 400 });
  }

  // Load the charge by the unguessable UUID. No row ⇒ spoofed / unknown.
  const rows = (await sql`
    SELECT id::text, agent_id::text, buyer_tg_user_id::text AS buyer_id,
           seller_tg_user_id::text AS seller_id, amount_credits::text AS amount,
           kind, status
    FROM transfer_charges WHERE id = ${userData}::uuid LIMIT 1
  `) as unknown as ChargeRow[];
  const c = rows[0];
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (event === 'failed' || event === 'error') {
    await sql`
      UPDATE transfer_charges SET status='failed'
      WHERE id = ${c.id}::uuid AND status NOT IN ('settled', 'failed')
    `;
    return NextResponse.json({ ok: true });
  }

  if (event === 'invoice_paid' || event === 'paid') {
    // Record the tx hash; leave status pending — the 'minted' event does the move.
    await sql`
      UPDATE transfer_charges SET nft_tx_hash = COALESCE(${txHash ?? null}, nft_tx_hash)
      WHERE id = ${c.id}::uuid AND status = 'pending'
    `;
    return NextResponse.json({ ok: true });
  }

  if (event === 'minted') {
    if (c.status === 'settled') {
      return NextResponse.json({ ok: true, skipped: 'already_settled' });
    }
    if (c.status === 'failed') {
      return NextResponse.json({ ok: true, skipped: 'failed' });
    }

    const buyerId = c.buyer_id;
    const sellerId = c.seller_id;
    const agentId = c.agent_id;
    const amount = Number(c.amount); // 0 for a gift
    let insufficient = false;
    let alreadyMoved = false;

    try {
      await sql.begin(async (sql) => {
        // a) CLAIM-GUARD: move ownership, guarded on the recorded OLD owner. 0 rows
        //    ⇒ already moved / not owned by the recorded seller ⇒ throw ⇒ rollback.
        const claim = (await sql`
          UPDATE agents SET tg_user_id = ${buyerId}::bigint, updated_at = NOW()
          WHERE id = ${agentId}::uuid AND tg_user_id = ${sellerId}::bigint AND status != 'deleted'
          RETURNING id::text
        `) as unknown as Array<{ id: string }>;
        if (claim.length === 0) {
          alreadyMoved = true;
          throw new Error('already_moved');
        }

        // b) SALE ONLY (amount > 0): guarded debit of the buyer (over-spend safe).
        if (amount > 0) {
          const debit = (await sql`
            UPDATE tg_user_balances
            SET balance_credits = balance_credits - ${amount}, updated_at = NOW()
            WHERE tg_user_id = ${buyerId}::bigint AND balance_credits >= ${amount}
            RETURNING balance_credits::text AS balance_credits
          `) as unknown as Array<{ balance_credits: string }>;
          if (debit.length === 0) {
            insufficient = true;
            throw new Error('insufficient_balance');
          }

          // c) UPSERT-CREDIT the seller 100% (AIAG 0%).
          const credit = (await sql`
            INSERT INTO tg_user_balances (tg_user_id, balance_credits, updated_at)
            VALUES (${sellerId}::bigint, ${amount}::bigint, NOW())
            ON CONFLICT (tg_user_id) DO UPDATE
              SET balance_credits = tg_user_balances.balance_credits + EXCLUDED.balance_credits,
                  updated_at = NOW()
            RETURNING balance_credits::text AS balance_credits
          `) as unknown as Array<{ balance_credits: string }>;

          // d) TWO equal-and-opposite ledger rows, ONE ref_id, idempotent.
          await sql`
            INSERT INTO tg_ledger_entries
              (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
            VALUES
              (${buyerId}::bigint, ${-amount}, 'transfer_debit', 'transfer_charge',
               ${c.id}::uuid, ${debit[0]!.balance_credits}::bigint)
            ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
          `;
          await sql`
            INSERT INTO tg_ledger_entries
              (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
            VALUES
              (${sellerId}::bigint, ${amount}, 'transfer_credit', 'transfer_charge',
               ${c.id}::uuid, ${credit[0]!.balance_credits}::bigint)
            ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
          `;
        }

        // e) WIPE personal history (CONTEXT.md: личные чаты стёрты).
        await sql`DELETE FROM agent_runs WHERE agent_id = ${agentId}::uuid`;

        // f) STRIP secrets the new owner must not inherit (spec-not-data) + reset
        //    budget to the 0029 column default ($1000) + clear the transfer flags +
        //    store the minted item address on the existing agents.nft_address (0039).
        await sql`
          UPDATE agents SET
            external_api_key_encrypted = NULL, external_api_key_hint = NULL,
            external_base_url = NULL, external_model_slug = NULL,
            mcp_auth_encrypted = NULL, connection_type = 'aiag',
            budget_credits_monthly = 100000, spent_today_credits = 0,
            transferable = FALSE, transfer_price_credits = NULL,
            nft_address = ${item ?? nftAddress ?? null},
            updated_at = NOW()
          WHERE id = ${agentId}::uuid
        `;

        // g) MEMORY RE-KEY SEAM (STUB until R1.2 D-5): memory is near-empty pre-D-5,
        //    so this is a no-op now. Plan 16-04 owns the seam doc/edge-cases.
        //    TODO(D-5): re-encrypt the obezličennaja agent_memory blob to the new
        //    owner's key. Do NOT implement X25519 here.

        // h) Settle the charge + record the tx hash.
        await sql`
          UPDATE transfer_charges
          SET status='settled', nft_tx_hash = COALESCE(${txHash ?? null}, nft_tx_hash), settled_at = NOW()
          WHERE id = ${c.id}::uuid AND status <> 'settled'
        `;
      });
    } catch (e) {
      // WARNING-1 fix: mark the charge FAILED on any rollback so a buyer is never
      // permanently locked out behind a stuck 'pending' (409 transfer_pending) after
      // they paid the mint. Done OUTSIDE the rolled-back tx, guarded on 'pending' so
      // a settled charge is NEVER overwritten.
      await sql`UPDATE transfer_charges SET status='failed' WHERE id = ${c.id}::uuid AND status = 'pending'`;
      if (insufficient) {
        return NextResponse.json({ ok: false, error: 'insufficient_balance' }, { status: 402 });
      }
      if (alreadyMoved) {
        return NextResponse.json({ ok: true, skipped: 'already_moved' });
      }
      console.error('transfer finalize failed:', e);
      return NextResponse.json({ ok: false, error: 'finalize_failed' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: event });
}
