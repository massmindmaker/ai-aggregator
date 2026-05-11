/**
 * POST /api/admin/models/[slug]/image
 *
 * Upload a cover image for a model. Stores file in S3 and updates
 * the `image_url` column on the `models` table.
 *
 * Constraints:
 *   - Admin auth required
 *   - Accepted types: image/png, image/jpeg, image/webp (validated by magic bytes)
 *   - Max size: 2 MB
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAdmin } from '@/lib/admin/api';
import { uploadToS3 } from '@aiag/shared';
import { db, sql } from '@/lib/db';

export const runtime = 'nodejs';

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const SLUG_RE = /^[a-z0-9_\-/.]{1,120}$/;

const EXT_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function detectMime(buf: Buffer): string | null {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  return withAdmin(async () => {
    const { slug } = await params;

    if (!SLUG_RE.test(slug)) {
      return NextResponse.json({ error: 'invalid_slug' }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get('image') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'image_required' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'too_large', maxMb: 2 }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const detectedMime = detectMime(buffer);
    if (!detectedMime) {
      return NextResponse.json({ error: 'invalid_type', allowed: Object.keys(EXT_MAP) }, { status: 400 });
    }

    const ext = EXT_MAP[detectedMime];
    const key = `models/${slug}/cover.${ext}`;
    const imageUrl = await uploadToS3(key, buffer, detectedMime);

    await db.execute(sql`
      UPDATE models
      SET image_url = ${imageUrl},
          updated_at = NOW()
      WHERE slug = ${slug}
    `);

    return NextResponse.json({ imageUrl });
  });
}
