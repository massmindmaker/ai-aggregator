import { NextRequest, NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { withAdmin } from '@/lib/admin/api';
import { audit } from '@/lib/admin/guard';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const updateSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  image_url: z.string().url().nullable().optional().or(z.literal('')),
  startonus_collection_id: z.string().max(200).nullable().optional().or(z.literal('')),
  price_nano_ton: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v == null ? undefined : String(v)))
    .refine((v) => v === undefined || (/^\d+$/.test(v) && BigInt(v) > 0n), 'price_nano_ton invalid'),
  max_supply: z
    .union([z.string(), z.number()])
    .nullable()
    .optional()
    .transform((v) => (v == null || v === '' ? null : Number(v))),
  status: z.enum(['draft', 'active', 'sold_out', 'archived']).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(async ({ user: admin }) => {
    const { id } = await ctx.params;
    const raw = await req.json().catch(() => null);
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });
    }
    const data = parsed.data;

    const result = await db.execute(sql`
      UPDATE nft_collections SET
        name = COALESCE(${data.name ?? null}, name),
        description = COALESCE(${data.description ?? null}, description),
        image_url = COALESCE(${data.image_url || null}, image_url),
        startonus_collection_id = COALESCE(${data.startonus_collection_id || null}, startonus_collection_id),
        price_nano_ton = COALESCE(${data.price_nano_ton ?? null}::bigint, price_nano_ton),
        max_supply = COALESCE(${data.max_supply}::int, max_supply),
        status = COALESCE(${data.status ?? null}, status),
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING id::text, slug, name, status
    `);

    const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
    const collection = rows[0] as
      | { id: string; slug: string; name: string; status: string }
      | undefined;

    if (!collection) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    await audit(admin.email, 'nft_collection.update', 'nft_collection', id, data as never);
    return NextResponse.json({ collection });
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withAdmin(async ({ user: admin }) => {
    const { id } = await ctx.params;

    // Restrict delete if any mints happened
    const check = await db.execute(
      sql`SELECT minted_count, slug FROM nft_collections WHERE id = ${id}::uuid`
    );
    const checkRows =
      (check as unknown as { rows?: Array<{ minted_count: number; slug: string }> }).rows ??
      (check as unknown as Array<{ minted_count: number; slug: string }>);
    const row = checkRows[0];
    if (!row) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (Number(row.minted_count) > 0) {
      return NextResponse.json(
        {
          error: 'HAS_MINTS',
          message: 'Нельзя удалить коллекцию с заминченными NFT. Архивируйте её вместо удаления.',
        },
        { status: 409 }
      );
    }

    await db.execute(sql`DELETE FROM nft_collections WHERE id = ${id}::uuid`);
    await audit(admin.email, 'nft_collection.delete', 'nft_collection', id, { slug: row.slug });
    return NextResponse.json({ ok: true });
  });
}
