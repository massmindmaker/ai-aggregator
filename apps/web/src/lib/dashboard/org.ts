import { db } from "@/lib/db";
import { organizations, organizationMembers } from "@aiag/database/schema";
import { eq, and, asc, type Database } from "@aiag/database";

type OrgDatabase = Pick<Database, "query" | "insert">;

/**
 * Resolve (or auto-create) the default organization for a given user.
 *
 * Strategy:
 *   1. Look up first organization where user is a member.
 *   2. If none exists, look up an organization owned by user.
 *   3. If still none, create a personal organization with slug derived from
 *      the user id (so it's stable per user).
 *
 * Returns the organization id.
 */
export async function getOrCreateDefaultOrg(
  userId: string,
  database: OrgDatabase = db,
): Promise<string> {
  // 1. Membership lookup
  const member = await database.query.organizationMembers.findFirst({
    where: eq(organizationMembers.userId, userId),
    orderBy: [asc(organizationMembers.joinedAt), asc(organizationMembers.id)],
  });
  if (member) return member.organizationId;

  // 2. Owner lookup
  const owned = await database.query.organizations.findFirst({
    where: eq(organizations.ownerId, userId),
    orderBy: [asc(organizations.createdAt), asc(organizations.id)],
  });
  if (owned) return owned.id;

  // 3. Auto-create personal org. Slug must be unique → use short user-id slice.
  const slug = `user-${userId.slice(0, 8)}-${Date.now().toString(36)}`;
  const [created] = await database
    .insert(organizations)
    .values({
      slug,
      name: "Personal Workspace",
      ownerId: userId,
    })
    .returning();
  if (!created) throw new Error("failed_to_create_org");

  // Add owner as a member with admin role for completeness.
  await database
    .insert(organizationMembers)
    .values({
      organizationId: created.id,
      userId,
      role: "admin",
    })
    .onConflictDoNothing();

  return created.id;
}

/**
 * Verify the given user belongs to the given org (owner or member).
 */
export async function userHasOrgAccess(
  userId: string,
  orgId: string,
): Promise<boolean> {
  const owner = await db.query.organizations.findFirst({
    where: and(eq(organizations.id, orgId), eq(organizations.ownerId, userId)),
  });
  if (owner) return true;
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.organizationId, orgId),
      eq(organizationMembers.userId, userId),
    ),
  });
  return !!member;
}
