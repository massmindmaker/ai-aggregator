import { NextResponse } from "next/server";
import {
  getAuthenticatedUser,
  mockPayoutSchema,
  readAuthorInput,
  authorApiError,
} from "@/lib/author/http";
import {
  AuthorOperationError,
  requestMockAuthorPayout,
} from "@/lib/author/service";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser)
      return NextResponse.json(
        { error: "AUTHENTICATION_REQUIRED" },
        { status: 401 },
      );
    const input = await readAuthorInput(req, mockPayoutSchema),
      key = req.headers.get("idempotency-key");
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new AuthorOperationError("AUTHOR_INPUT_INVALID", 400);
    return NextResponse.json(
      await requestMockAuthorPayout(authUser.user.id, key, input),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authorApiError(error);
  }
}
