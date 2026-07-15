import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { contests, contestParticipants } from '@aiag/database/schema';
import { eq, and } from '@aiag/database';

/**
 * POST /api/contests/[slug]/register
 *
 * Registers the authenticated user as a contest participant. Idempotent:
 * a repeat registration for the same (contest, user) does not duplicate
 * the row — enforced both by ON CONFLICT DO NOTHING and the DB's unique
 * index `contest_participants_contest_user_idx`.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { message: 'Требуется вход', code: 'UNAUTHORIZED' } },
      { status: 401 }
    );
  }
  const userId = session.user.id;

  const { slug } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    rulesAccepted?: boolean;
    privacyAccepted?: boolean;
  };

  if (!body.rulesAccepted || !body.privacyAccepted) {
    return NextResponse.json(
      {
        error: {
          message: 'Необходимо подтвердить правила и согласие на обработку ПД',
          code: 'CONSENT_REQUIRED',
        },
      },
      { status: 400 }
    );
  }

  // Load active contest by slug (same "active" gate as /submit).
  const contest = await db.query.contests.findFirst({
    where: and(eq(contests.slug, slug), eq(contests.status, 'active')),
  });

  if (!contest) {
    return NextResponse.json(
      { error: { message: 'Конкурс не найден или не активен', code: 'NOT_FOUND' } },
      { status: 404 }
    );
  }

  const now = new Date();
  if (contest.startsAt && now < contest.startsAt) {
    return NextResponse.json(
      { error: { message: 'Конкурс ещё не начался', code: 'CONTEST_NOT_STARTED' } },
      { status: 400 }
    );
  }
  if (contest.endsAt && now > contest.endsAt) {
    return NextResponse.json(
      { error: { message: 'Приём заявок завершён', code: 'CONTEST_ENDED' } },
      { status: 400 }
    );
  }

  // Idempotent insert: ON CONFLICT DO NOTHING on (contest_id, user_id).
  await db
    .insert(contestParticipants)
    .values({ contestId: contest.id, userId })
    .onConflictDoNothing({
      target: [contestParticipants.contestId, contestParticipants.userId],
    });

  const participant = await db.query.contestParticipants.findFirst({
    where: and(
      eq(contestParticipants.contestId, contest.id),
      eq(contestParticipants.userId, userId)
    ),
  });

  return NextResponse.json({
    success: true,
    data: { slug, registered: true, participantId: participant?.id },
  });
}
