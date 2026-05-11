import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import {
  contests,
  contestParticipants,
  contestSubmissions,
  evaluatorScripts,
} from '@aiag/database/schema';
import { eq, and } from '@aiag/database';
import { uploadToS3, getSignedDownloadUrl } from '@aiag/shared';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  // 1. Auth
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { message: 'Требуется вход', code: 'UNAUTHORIZED' } },
      { status: 401 }
    );
  }
  const userId = session.user.id;

  const { slug } = await params;

  // 2. Load active contest by slug
  const contest = await db.query.contests.findFirst({
    where: and(eq(contests.slug, slug), eq(contests.status, 'active')),
  });

  if (!contest) {
    return NextResponse.json(
      { error: { message: 'Конкурс не найден или не активен', code: 'NOT_FOUND' } },
      { status: 404 }
    );
  }

  // 3. Check date range — contest must be open
  const now = new Date();
  if (contest.startsAt && now < contest.startsAt) {
    return NextResponse.json(
      { error: { message: 'Конкурс ещё не начался', code: 'CONTEST_NOT_STARTED' } },
      { status: 400 }
    );
  }
  if (contest.endsAt && now > contest.endsAt) {
    return NextResponse.json(
      { error: { message: 'Приём заявок завершён', code: 'CONTEST_ENDED' } },
      { status: 400 }
    );
  }

  // 4. Parse FormData
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: { message: 'Невалидный FormData', code: 'BAD_REQUEST' } },
      { status: 400 }
    );
  }

  const submissionFile = formData.get('submission');
  if (!submissionFile || !(submissionFile instanceof File)) {
    return NextResponse.json(
      { error: { message: 'Поле submission (файл) обязательно', code: 'BAD_REQUEST' } },
      { status: 400 }
    );
  }

  if (submissionFile.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: { message: 'Максимальный размер файла — 50 MB', code: 'FILE_TOO_LARGE' } },
      { status: 413 }
    );
  }

  const description = formData.get('description');
  const descriptionText =
    description && typeof description === 'string' ? description.trim() : null;

  // 5. Upload file to S3
  const fileBuffer = Buffer.from(await submissionFile.arrayBuffer());
  const filename = submissionFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const s3Key = `submissions/${contest.id}/${userId}/${Date.now()}-${filename}`;

  let fileUrl: string;
  try {
    fileUrl = await uploadToS3(s3Key, fileBuffer, submissionFile.type || 'application/octet-stream', { private: true });
  } catch (err) {
    console.error('[submit] S3 upload failed:', err);
    return NextResponse.json(
      { error: { message: 'Ошибка при загрузке файла', code: 'UPLOAD_FAILED' } },
      { status: 500 }
    );
  }

  // 6. Find or ensure participant record
  let participant = await db.query.contestParticipants.findFirst({
    where: and(
      eq(contestParticipants.contestId, contest.id),
      eq(contestParticipants.userId, userId)
    ),
  });

  if (!participant) {
    // Auto-register the participant on first submission
    const [inserted] = await db
      .insert(contestParticipants)
      .values({
        contestId: contest.id,
        userId,
      })
      .returning();
    participant = inserted;
  }

  if (!participant) {
    return NextResponse.json(
      { error: { message: 'Не удалось зарегистрировать участника', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }

  // 7. Insert submission record (status='pending')
  const [submission] = await db
    .insert(contestSubmissions)
    .values({
      contestId: contest.id,
      participantId: participant.id,
      userId,
      fileUrl,
      fileName: submissionFile.name,
      fileSize: submissionFile.size,
      description: descriptionText,
      status: 'pending',
    })
    .returning({ id: contestSubmissions.id });

  if (!submission) {
    return NextResponse.json(
      { error: { message: 'Ошибка при сохранении submission', code: 'INTERNAL_ERROR' } },
      { status: 500 }
    );
  }

  // 8. Try to enqueue BullMQ eval job — silently catch errors
  let queue: import('bullmq').Queue | null = null;
  try {
    // Look up approved evaluator script for this contest
    const evaluatorScript = await db.query.evaluatorScripts.findFirst({
      where: and(
        eq(evaluatorScripts.contestId, contest.id),
        eq(evaluatorScripts.status, 'approved')
      ),
    });

    if (evaluatorScript) {
      // Dynamic import so missing bullmq dep doesn't break the route at startup
      const { Queue } = await import('bullmq');

      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
      const url = new URL(redisUrl);
      // Queue name matches QUEUE_NAMES.contestEval in apps/worker/src/queues/names.ts
      queue = new Queue('contest-eval', {
        connection: {
          host: url.hostname,
          port: Number(url.port) || 6379,
          password: url.password || undefined,
          tls: url.protocol === 'rediss:' ? {} : undefined,
        },
      });

      // Файл лежит как private — генерим signed URL на 24 часа для воркера.
      // Если presign упал, фолбэк на storage URL (admin сможет реран позже).
      let downloadUrl = fileUrl;
      try {
        downloadUrl = await getSignedDownloadUrl(s3Key, 24 * 3600);
      } catch (presignErr) {
        console.warn('[submit] presign failed, falling back to storage URL:', presignErr);
      }

      await queue.add('eval', {
        submissionId: submission.id,
        evaluatorScriptId: evaluatorScript.id,
        scriptSource: evaluatorScript.s3Key,
        submissionFiles: [{ name: submissionFile.name, url: downloadUrl }],
        inputJson: null,
      });
    }
  } catch (err) {
    // BullMQ not available in web or Redis unreachable — submission is already saved.
    // Admin can retrigger evaluation manually.
    console.warn('[submit] Could not enqueue eval job:', err instanceof Error ? err.message : err);
  } finally {
    if (queue) {
      // Avoid leaking Redis connections on enqueue errors.
      queue.close().catch(() => { /* ignore close errors */ });
    }
  }

  return NextResponse.json(
    { submissionId: submission.id, status: 'pending' },
    { status: 201 }
  );
}
