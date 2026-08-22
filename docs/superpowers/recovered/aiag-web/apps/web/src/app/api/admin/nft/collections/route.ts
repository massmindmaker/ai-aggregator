import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const createSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Slug: только a-z, 0-9, дефис'),
  name: z.string().min(2).max(200),
  description: z.string().max(5000).optional().nullable(),
  image_url: z.string().url().optional().nullable().or(z.literal('')),
  startonus_collection_id: z.string().max(200).optional().nullable().or(z.literal('')),
  /** Nano TON as string (BigInt-safe) */
  price_nano_ton: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, 'price_nano_ton must be positive integer string'),
  max_supply: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => (v == null || v === '' ? null : Number(v)))
    .refine((v) => v == null || (Number.isInteger(v) && v > 0), 'max_supply must be positive integer'),
});

export async function GET() {
  return withAdmin(async () => {
    const r = await db.execute(sql`
      SELECT id::text, slug, name, description, image_url,
             startonus_collection_id, price_nano_ton::text,
             max_supply, minted_count, status,
             created_at, updated_at
      FROM nft_collections
      ORDER BY created_at DESC
      LIMIT 500
    `);
    const rows = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) || [];
    return NextResponse.json({ collections: rows });
  });
}

export async function POST(req: NextRequest) {
  return withAdmin(async ({ user: admin }) => {
    const raw = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
    }
    const data = parsed.data;

    // Slug uniqueness check
    const existing = await db.execute(
      sql`SELECT 1 FROM nft_collections WHERE slug = ${data.slug} LIMIT 1`
    );
    const existingRows =
      (existing as unknown as { rows?: unknown[] }).rows ?? (existing as unknown as unknown[]);
    if (existingRows.length > 0) {
      return NextResponse.json(
        { error: 'SLUG_TAKEN', message: 'Этот slug уже занят' },
        { status: 409 }
      );
    }

    const result = await db.execute(sql`
      INSERT INTO nft_collections (
        slug, name, description, image_url, startonus_collection_id,
        price_nano_ton, max_supply, status, created_at, updated_at
      )
      VALUES (
        ${data.slug}, ${data.name},
        ${data.description || null},
        ${data.image_url || null},
        ${data.startonus_collection_id || null},
        ${data.price_nano_ton}::bigint,
        ${data.max_supply},
        'draft',
        NOW(), NOW()
      )
      RETURNING id::text, slug, name, status
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
    const collection = rows[0] as
      | { id: string; slug: string; name: string; status: string }
      | undefined;

    if (!collection) {
      return NextResponse.json({ error: 'INSERT failed' }, { status: 500 });
    }

    await audit(admin.email, 'nft_collection.create', 'nft_collection', collection.id, {
      slug: data.slug,
      name: data.name,
      price_nano_ton: data.price_nano_ton,
    });

    return NextResponse.json({ collection }, { status: 201 });
  });
}
