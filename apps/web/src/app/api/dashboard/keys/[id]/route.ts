import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { gatewayApiKeys } from '@aiag/database/schema';
import { and, eq } from '@aiag/database';
import { getOrCreateDefaultOrg } from '@/lib/dashboard/org';
import { invalidateApiKeyCache } from '@/lib/dashboard/gateway-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  costLimitMonthlyRub: z.number().positive().max(10_000_000).nullable().optional(),
  ruResidencyOnly: z.boolean().optional(),
  modelWhitelist: z.array(z.string().min(1).max(128)).max(200).optional(),
  disabled: z.boolean().optional(), // true → set disabled_at; false → clear
});

async function ensureOwned(userId: string, keyId: string) {
  const orgId = await getOrCreateDefaultOrg(userId);
  const found = await db.query.gatewayApiKeys.findFirst({
    where: and(eq(gatewayApiKeys.id, keyId), eq(gatewayApiKeys.orgId, orgId)),
  });
  return found ? { orgId, key: found } : null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const owned = await ensureOwned(session.user.id, id);
  if (!owned) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const raw = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation_failed',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.costLimitMonthlyRub !== undefined) {
    update.costLimitMonthlyRub =
      parsed.data.costLimitMonthlyRub === null
        ? null
        : String(parsed.data.costLimitMonthlyRub);
  }
  if (parsed.data.ruResidencyOnly !== undefined) {
    update.ruResidencyOnly = parsed.data.ruResidencyOnly;
  }
  if (parsed.data.modelWhitelist !== undefined) {
    update.modelWhitelist = parsed.data.modelWhitelist;
  }
  if (parsed.data.disabled !== undefined) {
    update.disabledAt = parsed.data.disabled ? new Date() : null;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no_changes' }, { status: 400 });
  }

  const [row] = await db
    .update(gatewayApiKeys)
    .set(update)
    .where(eq(gatewayApiKeys.id, id))
    .returning();

  // #4: any change here (disable, cost cap, whitelist, residency) must not
  // wait out the gateway's 5-minute auth cache — purge it immediately.
  await invalidateApiKeyCache(owned.key.keyHash);

  return NextResponse.json({ ok: true, record: row });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const owned = await ensureOwned(session.user.id, id);
  if (!owned) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Soft delete: set disabled_at + revoked_at.
  await db
    .update(gatewayApiKeys)
    .set({ disabledAt: new Date(), revokedAt: new Date() })
    .where(eq(gatewayApiKeys.id, id));

  // #4: without this a just-deleted key keeps authenticating off the
  // gateway's cached copy for up to 5 more minutes.
  await invalidateApiKeyCache(owned.key.keyHash);

  return NextResponse.json({ ok: true });
}
