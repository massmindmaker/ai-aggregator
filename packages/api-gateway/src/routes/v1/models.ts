/** GET /v1/models — enabled catalog, including explicitly activated reviewed author versions. */
import { Hono } from "hono";
import { sql } from "../../lib/db";
import { authorVersionListed } from "../../catalog/author-admission";
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
  WHERE m.enabled AND ${authorVersionListed(sql)}
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
