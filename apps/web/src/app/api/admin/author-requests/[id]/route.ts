import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/admin/api";
import { readAuthorInput, uuidSchema, authorApiError } from "@/lib/author/http";
import {
  authorOperatorSchema,
  operateAuthorRequest,
} from "@/lib/author/operator";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(async ({ user }) => {
    try {
      const id = uuidSchema.parse((await params).id),
        input = await readAuthorInput(req, authorOperatorSchema);
      return NextResponse.json(await operateAuthorRequest(id, user.id, input), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      return authorApiError(error);
    }
  });
}
