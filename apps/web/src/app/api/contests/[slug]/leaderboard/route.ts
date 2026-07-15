import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import { contests } from '@aiag/database/schema';
import { eq } from '@aiag/database';

/**
 * GET /api/contests/[slug]/leaderboard
 *
 * Reads real ranking data out of `contest_submissions.public_score`
 * (written by the contest-eval pipeline) — one row per participant,
 * their best public score, ranked. Private score is only revealed once
 * `contests.evaluation_ends_at` has passed (closest existing column to the
 * originally-planned `reveal_private_at`); before that it is always null
 * in the payload regardless of what is stored.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const contest = await db.query.contests.findFirst({
    where: eq(contests.slug, slug),
  });

  if (!contest) {
    return NextResponse.json(
      { error: { message: 'Конкурс не найден', code: 'NOT_FOUND' } },
      { status: 404 }
    );
  }

  const session = await auth();
  const currentUserId = session?.user?.id ?? null;

  const now = new Date();
  const privateRevealed = Boolean(
    contest.evaluationEndsAt && now >= contest.evaluationEndsAt
  );

  // Best public score per participant (ties broken by earliest submission),
  // joined to submission counts + first-submitted-at and the user profile.
  const res = await db.execute(sql`
    WITH best AS (
      SELECT DISTINCT ON (cs.user_id)
        cs.user_id,
        cs.public_score,
        cs.private_score
      FROM contest_submissions cs
      WHERE cs.contest_id = ${contest.id}
        AND cs.public_score IS NOT NULL
      ORDER BY cs.user_id, cs.public_score DESC, cs.created_at ASC
    ),
    counts AS (
      SELECT user_id,
             COUNT(*)::int AS submissions_count,
             MIN(created_at) AS first_submitted_at
      FROM contest_submissions
      WHERE contest_id = ${contest.id}
      GROUP BY user_id
    )
    SELECT
      b.user_id::text AS user_id,
      u.name,
      u.username,
      b.public_score::text AS public_score,
      b.private_score::text AS private_score,
      c.submissions_count,
      c.first_submitted_at::text AS first_submitted_at,
      RANK() OVER (ORDER BY b.public_score DESC) AS rank
    FROM best b
    JOIN users u ON u.id = b.user_id
    JOIN counts c ON c.user_id = b.user_id
    ORDER BY b.public_score DESC, c.first_submitted_at ASC
    LIMIT 200
  `);

  type Row = {
    user_id: string;
    name: string | null;
    username: string | null;
    public_score: string;
    private_score: string | null;
    submissions_count: number;
    first_submitted_at: string;
    rank: number;
  };
  const rows = ((res as unknown as { rows?: Row[] }).rows ?? (res as unknown as Row[])) as Row[];

  return NextResponse.json({
    rows: rows.map((r) => ({
      rank: r.rank,
      authorName: r.name ?? r.username ?? 'Участник',
      authorUsername: r.username ?? r.user_id.slice(0, 8),
      bestPublic: Number(r.public_score),
      bestPrivate: privateRevealed && r.private_score !== null ? Number(r.private_score) : null,
      submissionsCount: r.submissions_count,
      firstSubmittedAt: r.first_submitted_at,
      isCurrentUser: currentUserId !== null && r.user_id === currentUserId,
    })),
    privateRevealed,
    updatedAt: now.toISOString(),
  });
}
