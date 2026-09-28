import { NextResponse } from "next/server";
import { getAuthenticatedUser, authorApiError } from "@/lib/author/http";
import { getAuthorEarnings } from "@/lib/author/data";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user)
      return NextResponse.json(
        { error: "AUTHENTICATION_REQUIRED" },
        { status: 401 },
      );
    return NextResponse.json(await getAuthorEarnings(user.user.id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return authorApiError(error);
  }
}
