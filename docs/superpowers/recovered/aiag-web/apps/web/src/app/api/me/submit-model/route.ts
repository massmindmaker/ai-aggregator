import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { modelSubmissions } from '@aiag/database/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const submitModelSchema = z.object({
  name: z.string().min(2).max(200),
  slug: z
    .string()
    .min(2)
    .max(128)
    .regex(/^[a-z0-9-]+$/, 'slug должен быть в a-z, 0-9, "-"'),
  modality: z.enum(['chat', 'image', 'video', 'audio', 'embedding']),
  description: z.string().min(20).max(4000),
  outboundKind: z.enum(['cloud-api', 'hosted-on-aiag']),
  upstreamUrl: z.string().url().max(500).optional().nullable(),
  pricing: z.record(z.string(), z.unknown()).optional().default({}),
  ruResidency: z.boolean().optional().default(false),
  piiRisk: z.enum(['low', 'medium', 'high']).optional().default('low'),
  gdprApplicable: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { message: 'Требуется вход', code: 'UNAUTHORIZED' } },
      { status: 401 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = submitModelSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation_failed',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const data = parsed.data;
  if (data.outboundKind === 'cloud-api' && !data.upstreamUrl) {
    return NextResponse.json(
      { error: 'upstream_url_required_for_cloud_api' },
      { status: 400 },
    );
  }

  const [row] = await db
    .insert(modelSubmissions)
    .values({
      userId: session.user.id,
      name: data.name,
      slug: data.slug,
      modality: data.modality,
      description: data.description,
      outboundKind: data.outboundKind,
      upstreamUrl: data.upstreamUrl ?? null,
      pricing: data.pricing ?? {},
      ruResidency: data.ruResidency ?? false,
      piiRisk: data.piiRisk ?? 'low',
      gdprApplicable: data.gdprApplicable ?? false,
    })
    .returning({
      id: modelSubmissions.id,
      slug: modelSubmissions.slug,
      status: modelSubmissions.status,
      createdAt: modelSubmissions.createdAt,
    });

  // Best-effort admin notification (non-blocking).
  void notifyAdminOfSubmission(data.name, data.slug).catch(() => null);

  return NextResponse.json({ ok: true, submission: row }, { status: 201 });
}

async function notifyAdminOfSubmission(name: string, slug: string) {
  const tgToken = process.env.TG_ADMIN_BOT_TOKEN;
  const tgChat = process.env.TG_ADMIN_CHAT_ID;
  if (!tgToken || !tgChat) {
    console.info('[submit-model] new submission (no TG configured)', { name, slug });
    return;
  }
  const text = `Новая заявка на модель: ${name} (${slug})`;
  await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChat, text }),
  });
}
