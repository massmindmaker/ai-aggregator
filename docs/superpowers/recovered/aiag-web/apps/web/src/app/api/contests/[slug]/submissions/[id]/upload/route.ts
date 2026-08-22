import { NextRequest, NextResponse } from 'next/server';

/**
 * MVP local-mock S3 PUT receiver. Drops body on the floor and returns 200.
 * Real path uses Timeweb S3 presigned URL (no app server involvement).
 */
export async function PUT(_req: NextRequest) {
  return new NextResponse(null, { status: 200 });
}
