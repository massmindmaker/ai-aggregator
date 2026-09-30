/**
 * Catalog bridge: create a model row on behalf of a given author.
 *
 * This is the publishing half of what the retired
 * `api/admin/contests/[slug]/publish-submission` route used to do, minus every
 * contest-specific concern: no final_rank/top-K check, no contest slug, no
 * `contest_submissions` UPDATE, no contest invite email. Contest publishing
 * belongs to Arena; the model catalog stays here because selling models is core
 * product.
 */
import { NextResponse } from "next/server";
import { db, sql } from "@/lib/db";
import { withAdmin } from "@/lib/admin/api";
import { audit } from "@/lib/admin/guard";
import { rowsOf } from "@/lib/admin/rows";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{3,80}$/;

const HOSTING_VALUES = [
  "cloud_api_wrap",
  "hosted_on_aiag",
  "self_hosted_by_author",
] as const;
type Hosting = (typeof HOSTING_VALUES)[number];

export async function POST(req: Request) {
  return withAdmin(async ({ user }) => {
    const body = (await req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    const author_user_id = String(body.author_user_id ?? "").trim();
    const model_slug = String(body.model_slug ?? "").trim();
    const display_name = String(body.display_name ?? "").trim();
    const descriptionRaw = body.description;
    const description =
      descriptionRaw === null || descriptionRaw === undefined || descriptionRaw === ""
        ? null
        : String(descriptionRaw);
    const hosting_strategy = String(
      body.hosting_strategy ?? "cloud_api_wrap",
    ) as Hosting;
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];

    if (!UUID_RE.test(author_user_id))
      return NextResponse.json({ error: "INVALID_AUTHOR_ID" }, { status: 400 });
    if (!model_slug || !display_name)
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    if (!SLUG_RE.test(model_slug))
      return NextResponse.json({ error: "INVALID_SLUG" }, { status: 400 });
    if (!HOSTING_VALUES.includes(hosting_strategy))
      return NextResponse.json({ error: "INVALID_HOSTING" }, { status: 400 });

    // 1. The author must exist — models.author_user_id is an FK to users and a
    //    bad value would surface as an opaque constraint violation.
    const author = rowsOf<{ id: string }>(
      await db.execute(
        sql`SELECT id::text AS id FROM users WHERE id = ${author_user_id}::uuid LIMIT 1`,
      ),
    )[0];
    if (!author)
      return NextResponse.json({ error: "AUTHOR_NOT_FOUND" }, { status: 404 });

    // 2. Slug uniqueness.
    const dup = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT id::text AS id FROM models WHERE slug = ${model_slug}`),
    )[0];
    if (dup) return NextResponse.json({ error: "SLUG_TAKEN" }, { status: 409 });

    // 3. Insert the model in the pending-author-consent state, unpublished.
    const inserted = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO models (slug, name, description, status, hosting_strategy,
                            author_user_id, derived_from_contest_id, type, enabled, tags)
        VALUES (${model_slug}, ${display_name}, ${description}, 'pending_author_consent',
                ${hosting_strategy}, ${author_user_id}::uuid, NULL,
                'llm', false, ${tags})
        RETURNING id::text AS id
      `),
    );
    const model_id = inserted[0]?.id;
    if (!model_id)
      return NextResponse.json({ error: "INSERT_FAILED" }, { status: 500 });

    await audit(user.email ?? null, "model.create_from_dashboard", "model", model_id, {
      model_slug,
      author_user_id,
      hosting_strategy,
      tags,
    });

    return NextResponse.json({ ok: true, model_id, model_slug });
  });
}
