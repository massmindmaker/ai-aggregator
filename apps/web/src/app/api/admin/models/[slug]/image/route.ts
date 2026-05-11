/**
 * POST /api/admin/models/[slug]/image
 *
 * Upload a cover image for a model. Stores file in S3 and updates
 * the `image_url` column on the `models` table.
 *
 * Constraints:
 *   - Admin auth required
 *   - Accepted types: image/png, image/jpeg, image/webp
 *   - Max size: 2 MB
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/admin/api';
import { uploadToS3 } from '@aiag/shared';
import { db, sql } from '@/lib/db';

export const runtime = 'nodejs';

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  return withAdmin(async () => {
    const { slug } = await params;

    const formData = await req.formData();
    const file = formData.get('image') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'image_required' }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'invalid_type', allowed: ALLOWED_TYPES },
        { status: 400 }
      );
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'too_large', maxMb: 2 }, { status: 400 });
    }

    const ext = file.type.split('/')[1];
    const key = `models/${slug}/cover.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const imageUrl = await uploadToS3(key, buffer, file.type);

    await db.execute(sql`
      UPDATE models
      SET image_url = ${imageUrl},
          updated_at = NOW()
      WHERE slug = ${slug}
    `);

    return NextResponse.json({ imageUrl });
  });
}
