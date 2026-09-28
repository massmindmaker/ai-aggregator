/** GET /v1/models — enabled catalog, including explicitly activated reviewed author versions. */
import { Hono } from "hono";
import { sql } from "../../lib/db";
import { config } from "../../config";
export const models = new Hono();
models.get("/", async (c) => {
  const rows = await sql<
    Array<{
      slug: string;
      type: string;
      created: number;
      author_version_id: string | null;
      price_microcredits: string | null;
      policy_digest: string | null;
    }>
  >`
  SELECT m.slug,m.type,EXTRACT(epoch FROM m.created_at)::int AS created,v.id::text AS author_version_id,p.price_microcredits::text,p.policy_digest
  FROM models m LEFT JOIN author_model_versions v ON v.id=m.current_author_version_id AND v.model_id=m.id
  LEFT JOIN author_price_policies p ON p.version_id=v.id
  WHERE m.enabled AND (m.author_user_id IS NULL OR (${config.AUTHOR_CHAT_ENABLED === "1"}::boolean AND m.status='live'
   AND v.status='approved' AND v.author_user_id=m.author_user_id AND p.approved_at IS NOT NULL AND p.accepted_by=v.author_user_id
   AND EXISTS(SELECT 1 FROM author_probe_operations probe WHERE probe.version_id=v.id AND probe.state='succeeded')
   AND EXISTS(SELECT 1 FROM users u WHERE u.id=v.author_user_id AND u.is_active AND NOT u.is_banned)))
  ORDER BY m.slug`;
  return c.json({
    object: "list",
    data: rows.map((r) => ({
      id: r.slug,
      object: "model",
      type: r.type,
      created: r.created,
      owned_by: r.author_version_id ? "author" : "aiag",
      ...(r.author_version_id
        ? {
            aiag_pricing: {
              unit: "request",
              price_microcredits: r.price_microcredits,
              author_version_id: r.author_version_id,
              policy_digest: r.policy_digest,
            },
          }
        : {}),
    })),
  });
});
