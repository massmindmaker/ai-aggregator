/**
 * Manual operator triage for `tg_membership_charges.status = 'needs_review'` (issue #29
 * round 7 — "из needs_review нет выхода"). The automated reconciler
 * (../membership-reconciler.ts) keeps retrying these rows forever, self-healing when the
 * chain state resolves — but it has no way to act on a genuinely stuck row (the mint truly
 * never happened, or an operator has manually confirmed the correct item off-band). This
 * script is that manual door. It is intentionally small: it does NOT bypass the exactly-once
 * claim guard (`tg_membership_tx_claims`), it only lets an operator supply the missing piece
 * of information (the correct on-chain item address + tier) that the automated matcher could
 * not determine on its own, or close a row that will never resolve.
 *
 * Usage (from apps/agent-worker; runs via tsx like the dev server, or `node dist/scripts/…`
 * after `bun run build`):
 *   npx tsx src/scripts/membership-review.ts list
 *     — print every needs_review / failed / long-pending charge with full context.
 *
 *   npx tsx src/scripts/membership-review.ts resolve <charge_id> <item_address> <tier>
 *     — attempt the SAME atomic claim+grant+settle path the reconciler uses, against an
 *       operator-supplied item address (e.g. found by manually browsing tonviewer/tonapi for
 *       the recipient wallet). Fails loudly if the item is already claimed by another charge
 *       — this script cannot force a double-grant.
 *
 *   npx tsx src/scripts/membership-review.ts close <charge_id> "<reason>"
 *     — mark a charge permanently 'failed' with an operator-authored reason, so it stops
 *       showing up in the reconciler's stuck sweep and the "N charge(s) in needs_review"
 *       alert. Use ONLY after off-chain investigation (and, if money was actually taken and
 *       is not recoverable on-chain, after a manual TON refund — this script has no custody
 *       of funds and cannot send TON; that step, if ever needed, is a manual wallet
 *       operation outside this codebase). Documented gap, not silently pretended away.
 *
 * DOES NOT run automatically; it is an operator tool, not part of the reconciler loop. It is
 * intentionally NOT wired into any HTTP route — running it requires VPS shell access, the
 * same bar as `sudo -u postgres psql` for a manual migration.
 */
import { sql } from '../db.js';
import { normalizeTonAddress } from '../membership-reconciler.js';

type Tier = 'creator' | 'builder' | 'studio';
const VALID_TIERS: readonly Tier[] = ['creator', 'builder', 'studio'];
const TIER_RANK: Record<string, number> = { creator: 1, builder: 2, studio: 3 };

async function list(): Promise<void> {
  const rows = (await sql`
    SELECT id::text, tg_user_id::text, tier, status, amount_nano_ton::text,
           recipient_address, item_address, tx_hash, failure_reason,
           created_at::text, chain_checked_at::text
    FROM tg_membership_charges
    WHERE status IN ('needs_review', 'failed')
       OR (status = 'pending' AND created_at < NOW() - INTERVAL '1 day')
    ORDER BY created_at ASC
  `) as unknown as Array<Record<string, string | null>>;

  if (rows.length === 0) {
    console.log('Nothing to review.');
    return;
  }
  for (const r of rows) {
    console.log('-'.repeat(60));
    console.log(`charge_id         ${r.id}`);
    console.log(`tg_user_id        ${r.tg_user_id}`);
    console.log(`status            ${r.status}`);
    console.log(`tier (requested)  ${r.tier}`);
    console.log(`amount_nano_ton   ${r.amount_nano_ton}`);
    console.log(`recipient         ${r.recipient_address}`);
    console.log(`item_address hint ${r.item_address ?? '(none)'}`);
    console.log(`tx_hash           ${r.tx_hash ?? '(none)'}`);
    console.log(`created_at        ${r.created_at}`);
    console.log(`chain_checked_at  ${r.chain_checked_at ?? '(never)'}`);
    console.log(`failure_reason    ${r.failure_reason ?? '(none)'}`);
  }
  console.log('-'.repeat(60));
  console.log(`${rows.length} row(s). Investigate on tonviewer/tonapi for the recipient address, then:`);
  console.log('  npx tsx src/scripts/membership-review.ts resolve <charge_id> <item_address> <tier>');
  console.log('  npx tsx src/scripts/membership-review.ts close <charge_id> "<reason>"');
}

async function resolveManually(chargeId: string, rawItemAddress: string, tier: string): Promise<void> {
  if (!(VALID_TIERS as readonly string[]).includes(tier)) {
    console.error(`invalid tier "${tier}" — must be one of ${VALID_TIERS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  // F1 (round 8): the operator copies the item address from tonviewer in user-friendly form
  // (`EQ…`/`UQ…`), but the reconciler keys `tg_membership_tx_claims.onchain_key` on
  // Address.toRawString() (`0:hex…`). Insert the RAW form here too, through the SAME
  // normalizeTonAddress the reconciler uses — otherwise the operator's `EQ…` key lands in a
  // different keyspace than the reconciler's `0:…` key for the SAME item, the exactly-once
  // guard is bypassed, and one transferred item could be minted into a membership TWICE.
  // The operator cannot route around this by pasting a different format: whatever they paste
  // is canonicalized before it touches the claims table or any comparison against it.
  const itemAddress = normalizeTonAddress(rawItemAddress);
  if (!itemAddress) {
    console.error(`item address "${rawItemAddress}" is not a parseable TON address — refusing.`);
    process.exitCode = 1;
    return;
  }
  const rows = (await sql`
    SELECT id::text, tg_user_id::text, status FROM tg_membership_charges WHERE id = ${chargeId}::uuid
  `) as unknown as Array<{ id: string; tg_user_id: string; status: string }>;
  const c = rows[0];
  if (!c) {
    console.error(`charge ${chargeId} not found`);
    process.exitCode = 1;
    return;
  }
  if (c.status === 'settled') {
    console.log(`charge ${chargeId} is already settled — nothing to do.`);
    return;
  }

  let granted = false;
  await sql.begin(async (sql) => {
    // Same exactly-once guard as the reconciler (tg_membership_tx_claims PK = onchain_key).
    const claim = (await sql`
      INSERT INTO tg_membership_tx_claims (onchain_key, charge_id, tg_user_id, tier)
      VALUES (${itemAddress}, ${c.id}::uuid, ${c.tg_user_id}::bigint, ${tier})
      ON CONFLICT (onchain_key) DO NOTHING
      RETURNING onchain_key
    `) as unknown as Array<{ onchain_key: string }>;
    if (claim.length === 0) {
      console.error(`item ${itemAddress} is ALREADY claimed by a different charge — refusing (no double-grant).`);
      return;
    }

    await sql`
      INSERT INTO tg_memberships (tg_user_id, tier, nft_address, source)
      VALUES (${c.tg_user_id}::bigint, ${tier}, ${itemAddress}, 'nft')
      ON CONFLICT (tg_user_id) DO UPDATE SET
        tier = CASE
          WHEN ${TIER_RANK[tier] ?? 0} >
               COALESCE(CASE tg_memberships.tier
                 WHEN 'studio'  THEN 3
                 WHEN 'builder' THEN 2
                 WHEN 'creator' THEN 1
               END, 0)
          THEN EXCLUDED.tier
          ELSE tg_memberships.tier
        END,
        nft_address = COALESCE(EXCLUDED.nft_address, tg_memberships.nft_address),
        source      = 'nft',
        revoked_at  = NULL,
        revoked_reason = NULL
    `;

    await sql`
      UPDATE tg_membership_charges
      SET status='settled', item_address = ${itemAddress}, tier = ${tier},
          failure_reason = 'manually resolved via src/scripts/membership-review.ts',
          settled_at = NOW()
      WHERE id = ${c.id}::uuid AND status <> 'settled'
    `;
    granted = true;
  });

  console.log(
    granted
      ? `Granted tier=${tier} to tg_user_id=${c.tg_user_id} via item=${itemAddress}.`
      : 'Nothing granted (see error above).',
  );
}

async function close(chargeId: string, reason: string): Promise<void> {
  const rows = (await sql`
    UPDATE tg_membership_charges
    SET status = 'failed', failure_reason = ${`manually closed: ${reason}`}
    WHERE id = ${chargeId}::uuid AND status IN ('needs_review', 'failed')
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;
  if (rows.length === 0) {
    console.error(
      `charge ${chargeId} not found, or not in needs_review/failed (refusing to close a live pending/settled charge).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Closed ${chargeId}. If real TON was taken and cannot be recovered on-chain, a manual refund is a SEPARATE, off-band wallet operation — this script does not send funds.`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'list') return list();
  if (cmd === 'resolve') {
    const [chargeId, itemAddress, tier] = args;
    if (!chargeId || !itemAddress || !tier) {
      console.error('usage: resolve <charge_id> <item_address> <tier>');
      process.exitCode = 1;
      return;
    }
    return resolveManually(chargeId, itemAddress, tier);
  }
  if (cmd === 'close') {
    const [chargeId, ...rest] = args;
    const reason = rest.join(' ');
    if (!chargeId || !reason) {
      console.error('usage: close <charge_id> "<reason>"');
      process.exitCode = 1;
      return;
    }
    return close(chargeId, reason);
  }
  console.error('usage: tsx src/scripts/membership-review.ts <list|resolve|close> [...args]');
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
