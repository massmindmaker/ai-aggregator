import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { rowsOf } from '@/lib/admin/rows';

export const dynamic = 'force-dynamic';

const HOSTING_VALUES = ['cloud_api_wrap', 'hosted_on_aiag', 'self_hosted_by_author'] as const;
type Hosting = (typeof HOSTING_VALUES)[number];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  return withAdmin(async ({ user }) => {
    const { slug } = await params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const submission_id = String((body as Record<string, unknown>).submission_id ?? '').trim();
    const model_slug = String((body as Record<string, unknown>).model_slug ?? '').trim();
    const display_name = String((body as Record<string, unknown>).display_name ?? '').trim();
    const descriptionRaw = (body as Record<string, unknown>).description;
    const description =
      descriptionRaw === null || descriptionRaw === undefined || descriptionRaw === ''
        ? null
        : String(descriptionRaw);
    const hosting_strategy = String(
      (body as Record<string, unknown>).hosting_strategy ?? 'cloud_api_wrap'
    ) as Hosting;
    const cost_raw = (body as Record<string, unknown>).cost_rub_override;
    const cost_rub_override =
      cost_raw === undefined || cost_raw === null || cost_raw === '' ? null : Number(cost_raw);
    const tagsRaw = (body as Record<string, unknown>).tags;
    const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : [];

    if (!submission_id || !model_slug || !display_name) {
      return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
    }
    if (!/^[a-z0-9-]{3,80}$/.test(model_slug)) {
      return NextResponse.json({ error: 'INVALID_SLUG' }, { status: 400 });
    }
    if (!HOSTING_VALUES.includes(hosting_strategy)) {
      return NextResponse.json({ error: 'INVALID_HOSTING' }, { status: 400 });
    }

    // 1. Look up submission + contest
    const sub = rowsOf<{ id: string; user_id: string; final_rank: number | null; contest_id: string }>(
      await db.execute(sql`
        SELECT cs.id::text, cs.user_id::text, cs.final_rank, cs.contest_id::text
        FROM contest_submissions cs
        JOIN contests c ON c.id = cs.contest_id
        WHERE cs.id = ${submission_id}::uuid AND c.slug = ${slug}
      `)
    )[0];
    if (!sub) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    if (sub.final_rank == null || sub.final_rank > 3) {
      return NextResponse.json({ error: 'NOT_TOP_K' }, { status: 400 });
    }

    // 2. Slug uniqueness
    const dup = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT id::text FROM models WHERE slug = ${model_slug}`)
    )[0];
    if (dup) return NextResponse.json({ error: 'SLUG_TAKEN' }, { status: 409 });

    // 3. Insert model
    const ins = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO models (slug, name, description, status, hosting_strategy,
                            author_user_id, derived_from_contest_id, type, enabled, tags)
        VALUES (${model_slug}, ${display_name}, ${description}, 'pending_author_consent',
                ${hosting_strategy}, ${sub.user_id}::uuid, ${sub.contest_id}::uuid,
                'llm', false, ${tags})
        RETURNING id::text
      `)
    );
    const model_id = ins[0]?.id;
    if (!model_id) return NextResponse.json({ error: 'INSERT_FAILED' }, { status: 500 });

    // 4. Link submission → model
    await db.execute(sql`
      UPDATE contest_submissions
      SET published_model_id = ${model_id}::uuid, published_at = NOW()
      WHERE id = ${submission_id}::uuid
    `);

    // 5. Audit
    await audit(user.email!, 'contest.publish_submission', 'contest_submission', submission_id, {
      model_id,
      model_slug,
      hosting_strategy,
      contest_slug: slug,
      cost_rub_override,
      tags,
    });

    // 6. Enqueue invite email — fail loud (W-5 fix per plan); email_jobs added in 0014.
    const consent_url = `/me/contest-wins/${submission_id}/publish`;
    await db.execute(sql`
      INSERT INTO email_jobs (to_user_id, template, payload, status, created_at)
      VALUES (${sub.user_id}::uuid, 'contest_publish_invite',
              ${JSON.stringify({ model_slug, contest_slug: slug, consent_url })}::jsonb,
              'pending', NOW())
    `);

    return NextResponse.json({ ok: true, model_id, model_slug });
  });
}
