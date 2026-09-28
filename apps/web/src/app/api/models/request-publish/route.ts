import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, sql } from '@/lib/db';
import { AuthorManifestError, parseAuthorSubmission } from '@aiag/shared/server';
import { deriveKek, encryptAesGcm } from '@aiag/upstream-adapters/byok';

/**
 * Candidate author submission. No endpoint probe, commercial terms or public
 * activation occurs in this first AG-P3 batch.
 */
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 16 * 1024;

async function getAuthenticatedUser() {
  const session = await auth();
  return session?.user?.id ? { user: session.user } : null;
}

async function readBoundedJson(req: NextRequest): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AuthorManifestError('INVALID_AUTHOR_SUBMISSION');
  }
  if (!req.body) throw new AuthorManifestError('INVALID_AUTHOR_SUBMISSION');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new AuthorManifestError('INVALID_AUTHOR_SUBMISSION');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new AuthorManifestError('INVALID_AUTHOR_SUBMISSION'); }
}

function uniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  return e.code === '23505' || e.cause?.code === '23505';
}

export async function POST(req: NextRequest) {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return NextResponse.json(
      { error: { message: 'Требуется вход' } },
      { status: 401 }
    );
  }

  let candidate: ReturnType<typeof parseAuthorSubmission>;
  try {
    candidate = parseAuthorSubmission(await readBoundedJson(req));
  } catch (error) {
    const code = error instanceof AuthorManifestError ? error.code : 'INVALID_AUTHOR_SUBMISSION';
    return NextResponse.json({ error: { code } }, { status: 400 });
  }

  const masterKey = process.env.AUTHOR_ENDPOINT_KEK;
  if (!masterKey) {
    return NextResponse.json({ error: { code: 'AUTHOR_KEY_UNAVAILABLE' } }, { status: 503 });
  }
  let encryptedToken: ReturnType<typeof encryptAesGcm>;
  try {
    const key = deriveKek(masterKey, 'aiag:author-endpoint:' + authUser.user.id + ':v1');
    encryptedToken = encryptAesGcm(candidate.authToken, key);
  } catch {
    return NextResponse.json({ error: { code: 'AUTHOR_KEY_UNAVAILABLE' } }, { status: 503 });
  }

  const hostingStrategy = candidate.hostedByIntent === 'author'
    ? 'self_hosted_by_author' : 'cloud_api_wrap';
  const metadata = {
    review_state: 'pending',
    hosted_by_intent: candidate.hostedByIntent,
    exclusive_intent: candidate.exclusiveIntent,
    submitted_at: new Date().toISOString(),
  };

  try {
    const created = await db.transaction(async (tx) => {
      const modelResult = await tx.execute(sql`
        INSERT INTO models (
          slug, type, enabled, display_name, description, metadata,
          author_user_id, hosting_strategy, status, tags
        ) VALUES (
          ${candidate.manifest.model.slug}, 'chat', false,
          ${candidate.manifest.model.displayName}, ${candidate.manifest.model.description},
          ${JSON.stringify(metadata)}::jsonb, ${authUser.user.id}::uuid,
          ${hostingStrategy}, 'draft', ARRAY[]::text[]
        )
        RETURNING id::text AS id, slug
      `);
      const modelRows = ((modelResult as unknown as { rows?: unknown[] }).rows ??
        modelResult) as Array<{ id: string; slug: string }>;
      const model = modelRows[0];
      if (!model) throw new Error('MODEL_INSERT_EMPTY');

      const versionResult = await tx.execute(sql`
        INSERT INTO author_model_versions (
          model_id, author_user_id, version_no, public_manifest,
          manifest_digest, encrypted_token_envelope, status
        ) VALUES (
          ${model.id}::uuid, ${authUser.user.id}::uuid, 1,
          ${candidate.manifestJson}::jsonb, ${candidate.manifestDigest},
          ${JSON.stringify(encryptedToken)}::jsonb, 'candidate'
        )
        RETURNING id::text AS id
      `);
      const versionRows = ((versionResult as unknown as { rows?: unknown[] }).rows ??
        versionResult) as Array<{ id: string }>;
      const version = versionRows[0];
      if (!version) throw new Error('VERSION_INSERT_EMPTY');

      await tx.execute(sql`
        INSERT INTO audit_log (actor_email, action, resource_type, resource_id, details, created_at)
        VALUES (
          ${authUser.user.email ?? null}, 'models.submit', 'model', ${model.id},
          ${JSON.stringify({ slug: model.slug, version_id: version.id })}::jsonb,
          NOW()
        )
      `);
      return { modelId: model.id, slug: model.slug, versionId: version.id };
    });

    return NextResponse.json({
      success: true,
      data: {
        id: created.modelId,
        slug: created.slug,
        versionId: created.versionId,
        manifestDigest: candidate.manifestDigest,
        status: 'draft',
      },
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      return NextResponse.json({ error: { code: 'SLUG_ALREADY_EXISTS' } }, { status: 409 });
    }
    return NextResponse.json(
      { error: { code: 'AUTHOR_SUBMISSION_UNAVAILABLE' } },
      { status: 500 }
    );
  }
}
