import { NextResponse } from 'next/server';
import { auth } from '@/auth';

/**
 * Plan 07 Task 5.3: submission confirm endpoint.
 * MVP: enqueues BullMQ `submission-eval` job (mocked). Real worker lives in
 * apps/worker (Task 7) and is deferred to the next wave.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      { error: { message: 'Требуется вход' } },
      { status: 401 }
    );
  }
  // TODO Task 7: enqueue `submission-eval` BullMQ job + insert audit_log.
  return NextResponse.json({ success: true, status: 'pending_eval' });
}
