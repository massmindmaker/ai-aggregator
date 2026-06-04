import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Optional comment ceiling — keep the audit row sane.
const MAX_COMMENT_LEN = 2000;

interface RateBody {
  stars?: number;
  comment?: string | null;
}

/**
 * POST /api/tma/templates/:id/rate — rate a template the caller actually USED.
 *
 * ELIGIBILITY GUARD (anti-spam, load-bearing): a rater may rate ONLY a template
 * they used — i.e. they own an agent whose template_kind = 'tpl:'||:id (they
 * cloned/rented it) OR they have a template_rentals row for this template. A rater
 * who never used the template gets 403 not_eligible. This stops drive-by rating of
 * the public catalog.
 *
 * UPSERT on (template_id, rater_tg_user_id) → a re-rate UPDATEs, never duplicates.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const raterId = req.headers.get('x-tma-user-id');
  if (!raterId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: RateBody;
  try {
    body = (await req.json()) as RateBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // stars must be an integer 1..5.
  const starsRaw = body.stars;
  if (typeof starsRaw !== 'number' || !Number.isInteger(starsRaw) || starsRaw < 1 || starsRaw > 5) {
    return NextResponse.json({ error: 'invalid_stars' }, { status: 400 });
  }
  const stars: number = starsRaw;

  const comment =
    typeof body.comment === 'string' && body.comment.trim().length > 0
      ? body.comment.slice(0, MAX_COMMENT_LEN)
      : null;

  // The template must exist; also load its author for the self-rating guard.
  const tplRows = (await sql`
    SELECT author_tg_user_id::text AS author_tg_user_id
    FROM agent_templates WHERE id = ${params.id}::uuid LIMIT 1
  `) as unknown as Array<{ author_tg_user_id: string }>;
  if (tplRows.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // SELF-RATING GUARD: an author cannot rate their OWN template (rank inflation),
  // mirroring the rent route's self-deal block. The eligibility guard below does
  // NOT cover this — an author can legitimately clone/rent-test their own template.
  if (tplRows[0]!.author_tg_user_id === raterId) {
    return NextResponse.json({ error: 'cannot_rate_own' }, { status: 403 });
  }

  // ELIGIBILITY GUARD: the rater must have actually USED this template — either they
  // own an agent cloned/rented from it (agents.template_kind = 'tpl:<id>'), OR they
  // hold a template_rentals row for it. Otherwise 403 not_eligible.
  const templateKind = `tpl:${params.id}`.slice(0, 40);
  const eligible = (await sql`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM agents
      WHERE tg_user_id = ${raterId}::bigint
        AND template_kind = ${templateKind}
    ) OR EXISTS (
      SELECT 1 FROM template_rentals
      WHERE template_id = ${params.id}::uuid
        AND renter_tg_user_id = ${raterId}::bigint
    )
  `) as unknown as Array<{ '?column?': number }>;
  if (eligible.length === 0) {
    return NextResponse.json({ error: 'not_eligible' }, { status: 403 });
  }

  // UPSERT on (template_id, rater_tg_user_id): a re-rate updates the same row.
  await sql`
    INSERT INTO template_ratings (template_id, rater_tg_user_id, stars, comment)
    VALUES (${params.id}::uuid, ${raterId}::bigint, ${stars}::smallint, ${comment})
    ON CONFLICT (template_id, rater_tg_user_id) DO UPDATE
      SET stars = EXCLUDED.stars,
          comment = EXCLUDED.comment,
          created_at = NOW()
  `;

  return NextResponse.json({ ok: true, stars }, { status: 200 });
}
