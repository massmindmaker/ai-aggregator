import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug: только a-z, 0-9, дефис'),
  name: z.string().min(3).max(120),
  description: z.string().max(5000).optional().default(''),
  total_prize_pool: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v != null && v !== '' ? Number(v) : null)),
  starts_at: z.string().datetime({ message: 'starts_at: ISO 8601 datetime required' }).optional().nullable(),
  ends_at: z.string().datetime({ message: 'ends_at: ISO 8601 datetime required' }).optional().nullable(),
  dataset_url: z.string().url().optional().nullable().or(z.literal('')),
  organization_id: z.string().uuid().optional().nullable().or(z.literal('')),
});

export async function POST(req: NextRequest) {
  return withAdmin(async ({ user: admin }) => {
    const raw = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
    }
    const { slug, name, description, total_prize_pool, starts_at, ends_at, dataset_url, organization_id } =
      parsed.data;

    // Check slug uniqueness
    const existing = await db.execute(sql`SELECT 1 FROM contests WHERE slug = ${slug} LIMIT 1`);
    const existingRows = (existing as unknown as { rows?: unknown[] }).rows ?? (existing as unknown as unknown[]);
    if (existingRows.length > 0) {
      return NextResponse.json({ error: 'SLUG_TAKEN', message: 'Этот slug уже занят' }, { status: 409 });
    }

    const startsAt = starts_at ? new Date(starts_at) : null;
    const endsAt = ends_at ? new Date(ends_at) : null;
    const prize = total_prize_pool ?? null;
    const orgId = organization_id || null;
    const datasetUrlVal = dataset_url || null;

    const result = await db.execute(sql`
      INSERT INTO contests (
        slug, name, description, total_prize_pool, starts_at, ends_at,
        dataset_url, organization_id, status, owner_id, is_public,
        created_at, updated_at
      )
      VALUES (
        ${slug}, ${name}, ${description}, ${prize}, ${startsAt}, ${endsAt},
        ${datasetUrlVal}, ${orgId},
        'draft'::contest_status,
        ${admin.id}::uuid,
        FALSE, NOW(), NOW()
      )
      RETURNING id::text, slug, name, status::text
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
    const contest = rows[0] as { id: string; slug: string; name: string; status: string } | undefined;

    if (!contest) {
      return NextResponse.json({ error: 'INSERT failed' }, { status: 500 });
    }

    await audit(admin.email, 'contest.create', 'contest', slug, { name, slug });

    return NextResponse.json({ contest }, { status: 201 });
  });
}
