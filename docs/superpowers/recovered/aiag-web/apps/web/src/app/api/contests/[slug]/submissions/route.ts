import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { randomUUID } from 'crypto';

/**
 * Plan 07 Task 5: POST /api/contests/[slug]/submissions
 * Returns signed-PUT URL + new submission_id. MVP uses a mock URL.
 *
 * Real flow (Task 22):
 *   1. auth + rate limit (pg_advisory_xact_lock on author_id+contest_id)
 *   2. INSERT contest_submissions (status='uploaded')
 *   3. issue Timeweb S3 presigned PUT on aiag-submissions/{contest}/{user}/{uuid}.csv
 *   4. return {submissionId, uploadUrl}
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { message: 'Требуется вход' } },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => ({}));
  if (!body?.fileName || typeof body.fileSize !== 'number') {
    return NextResponse.json(
      { error: { message: 'fileName и fileSize обязательны' } },
      { status: 400 }
    );
  }
  if (body.fileSize > 100 * 1024 * 1024) {
    return NextResponse.json(
      { error: { message: 'Максимум 100 MB' } },
      { status: 413 }
    );
  }

  const submissionId = randomUUID();
  // MVP: mocked local PUT; production → s3.getSignedUrl('putObject', {...})
  const uploadUrl = `/api/contests/${params.slug}/submissions/${submissionId}/upload`;

  return NextResponse.json({ submissionId, uploadUrl });
}
