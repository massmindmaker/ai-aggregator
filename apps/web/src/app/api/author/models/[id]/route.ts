import { NextResponse } from "next/server";
import {
  getAuthenticatedUser,
  ownerAuthorActionSchema,
  readAuthorInput,
  uuidSchema,
  authorApiError,
} from "@/lib/author/http";
import { acceptAuthorPolicy, submitAuthorVersion } from "@/lib/author/service";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser)
      return NextResponse.json(
        { error: "AUTHENTICATION_REQUIRED" },
        { status: 401 },
      );
    const modelId = uuidSchema.parse((await params).id),
      input = await readAuthorInput(req, ownerAuthorActionSchema);
    const result =
      input.action === "accept"
        ? await acceptAuthorPolicy(
            modelId,
            input.policyId,
            input.policyDigest,
            authUser.user.id,
          )
        : await submitAuthorVersion(modelId, authUser.user.id, input);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authorApiError(error);
  }
}
