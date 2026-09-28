import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db, sql } from "@/lib/db";
import { AuthorManifestError } from "@aiag/shared/server";
import { AuthorOperationError, authorOperationError } from "./service";

export const uuidSchema = z.string().uuid();
export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const exactMicrocredits = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/)
  .refine((v) => /^[0-9]+$/.test(v) && BigInt(v) <= 922337203685477580n);
const version = { versionId: uuidSchema, manifestDigest: digestSchema };
export const adminAuthorActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("probe"), ...version }).strict(),
  z
    .object({
      action: z.literal("review_probe"),
      ...version,
      evidenceReference: z.string().trim().min(3).max(1024),
    })
    .strict(),
  z
    .object({
      action: z.literal("propose"),
      ...version,
      priceMicrocredits: exactMicrocredits,
      authorShareBps: z.number().int().min(0).max(10000),
      rightsReference: z.string().trim().min(3).max(512),
      consentReference: z.string().trim().min(3).max(512),
      availabilityDelaySeconds: z.number().int().min(0).max(7776000),
    })
    .strict(),
  z
    .object({
      action: z.literal("approve"),
      ...version,
      policyId: uuidSchema,
      expectedCurrentVersionId: uuidSchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      status: z.enum(["frozen", "depublished", "live"]),
      expectedCurrentVersionId: uuidSchema.nullable(),
      reason: z.string().trim().min(3).max(500),
    })
    .strict(),
]);
export const ownerAuthorActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("accept"),
      policyId: uuidSchema,
      policyDigest: digestSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("new_version"),
      name: z.string().trim().min(3).max(128),
      description: z.string().trim().min(10).max(4000),
      endpointUrl: z.string().max(2048),
      authToken: z.string().min(1).max(4096),
      expectedLatestVersionNo: z.number().int().min(1).max(2147483646),
    })
    .strict(),
]);
export const mockPayoutSchema = z
  .object({
    recipientReference: z.string().regex(/^mock:[A-Za-z0-9._:-]{1,128}$/),
    amountMicrocredits: exactMicrocredits,
  })
  .strict();

export async function getAuthenticatedUser() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const result = await db.execute(
    sql`SELECT id FROM users WHERE id=${session.user.id}::uuid AND is_active=true AND is_banned=false`,
  );
  const values =
    (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  if (!values.length)
    throw new AuthorOperationError("AUTHOR_OWNER_REQUIRED", 403);
  return { user: session.user };
}
export async function readAuthorInput<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (
    req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json" ||
    !req.body
  )
    throw new AuthorOperationError("AUTHOR_INPUT_INVALID", 400);
  const reader = req.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0,
    expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, 5000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired || req.signal.aborted) throw new Error("cancelled");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) throw new Error("too large");
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const parsed = schema.safeParse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) throw new Error("invalid");
    return parsed.data;
  } catch {
    throw new AuthorOperationError("AUTHOR_INPUT_INVALID", 400);
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function authorApiError(error: unknown) {
  const result =
    error instanceof AuthorManifestError
      ? { code: error.code, status: 400 }
      : error instanceof z.ZodError
        ? { code: "AUTHOR_INPUT_INVALID", status: 400 }
        : authorOperationError(error);
  return NextResponse.json(
    { error: result.code },
    {
      status: result.status,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
