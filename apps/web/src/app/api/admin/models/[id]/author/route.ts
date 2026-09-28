import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/admin/api";
import {
  adminAuthorActionSchema,
  readAuthorInput,
  uuidSchema,
  authorApiError,
} from "@/lib/author/http";
import {
  probeAuthorVersion,
  proposeAuthorPolicy,
  approveAuthorVersion,
  changeAuthorModelStatus,
  reviewAuthorProbe,
} from "@/lib/author/service";
export const runtime = "nodejs";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin(async ({ user }) => {
    try {
      const modelId = uuidSchema.parse((await params).id),
        input = await readAuthorInput(req, adminAuthorActionSchema);
      if (input.action === "status")
        return NextResponse.json(
          await changeAuthorModelStatus(modelId, user.id, input),
        );
      const scope = {
        modelId,
        versionId: input.versionId,
        manifestDigest: input.manifestDigest,
        actorId: user.id,
      };
      const result =
        input.action === "review_probe"
          ? await reviewAuthorProbe(scope, input.evidenceReference)
          : input.action === "probe"
            ? await probeAuthorVersion(scope)
            : input.action === "propose"
              ? await proposeAuthorPolicy(scope, input)
              : await approveAuthorVersion(scope, input);
      return NextResponse.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      return authorApiError(error);
    }
  });
}
