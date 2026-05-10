import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import { models } from '@aiag/database/schema';
import { eq, and } from '@aiag/database';

/**
 * POST /api/models/request-publish
 *
 * Submits an author-owned model for moderation review.
 *
 * Mapping form → schema:
 *   - hostedBy='author' → hosting_strategy='self_hosted_by_author'
 *   - hostedBy='platform' → hosting_strategy='cloud_api_wrap' (we wrap the
 *     author's own endpoint behind our gateway).
 *   - status='draft' (DB CHECK constraint allows draft|pending_author_consent|
 *     live|frozen|depublished — there is no 'review' state, so we mark
 *     status=draft + metadata.review_state='pending' for the moderation queue).
 *   - enabled=false until admin approves.
 *
 * Sensitive fields (authToken) are stored in metadata for the MVP. FIXME:
 * encrypt with packages/shared/crypto.ts KEK before opening this to the
 * public — owner has acknowledged the gap.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { message: 'Требуется вход' } },
      { status: 401 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const required = ['name', 'slug', 'description', 'endpointUrl', 'authToken'];
  for (const k of required) {
    if (!body[k] || typeof body[k] !== 'string') {
      return NextResponse.json(
        { error: { message: `Поле ${k} обязательно` } },
        { status: 400 }
      );
    }
  }

  const slug = String(body.slug);
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json(
      { error: { message: 'slug должен содержать только a-z, 0-9, -' } },
      { status: 400 }
    );
  }
  if (slug.length < 3 || slug.length > 64) {
    return NextResponse.json(
      { error: { message: 'slug: 3-64 символов' } },
      { status: 400 }
    );
  }

  const existing = await db.query.models.findFirst({
    where: eq(models.slug, slug),
  });
  if (existing) {
    return NextResponse.json(
      { error: { message: 'Slug уже занят, выберите другой' } },
      { status: 409 }
    );
  }

  const hostedBy = body.hostedBy === 'author' ? 'author' : 'platform';
  const exclusive = Boolean(body.exclusive);
  const tierPct = hostedBy === 'author' && exclusive ? 85 : hostedBy === 'author' ? 80 : 70;
  const hostingStrategy =
    hostedBy === 'author' ? 'self_hosted_by_author' : 'cloud_api_wrap';

  const metadata = {
    review_state: 'pending' as const,
    endpoint_url: String(body.endpointUrl),
    // FIXME: encrypt with KEK from packages/shared/crypto.ts before public
    // launch. Plain-text in metadata is owner-acknowledged debt.
    auth_token: String(body.authToken),
    auth_header: typeof body.authHeader === 'string' ? body.authHeader : 'Authorization',
    pricing_hint_per_request_rub:
      typeof body.pricingHintPerRequestRub === 'number'
        ? body.pricingHintPerRequestRub
        : null,
    exclusive,
    hosted_by_intent: hostedBy,
    tier_pct: tierPct,
    contest_submission_id:
      typeof body.contestSubmissionId === 'string' ? body.contestSubmissionId : null,
    submitted_at: new Date().toISOString(),
  };

  try {
    const [inserted] = await db
      .insert(models)
      .values({
        slug,
        type: 'chat',
        enabled: false,
        displayName: String(body.name),
        description: String(body.description),
        metadata,
        authorUserId: session.user.id,
        hostingStrategy,
        status: 'draft',
        tags: [],
      })
      .returning({ id: models.id, slug: models.slug });

    // Best-effort audit; don't block on failure.
    try {
      await db.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (
          ${session.user.email ?? null},
          'models.submit',
          'model',
          ${inserted.id},
          ${JSON.stringify({ slug, hosted_by: hostedBy, exclusive })}::jsonb,
          NOW()
        )
      `);
    } catch (auditErr) {
      console.error('[request-publish] audit insert failed', auditErr);
    }

    return NextResponse.json({
      success: true,
      data: {
        id: inserted.id,
        slug: inserted.slug,
        status: 'review',
        tierPct,
      },
    });
  } catch (err) {
    console.error('[request-publish] insert failed', err);
    return NextResponse.json(
      { error: { message: 'Не удалось сохранить заявку — попробуйте позже' } },
      { status: 500 }
    );
  }
}
