import { db, sql } from "@/lib/db";
import { authorRows } from "./service";
export interface AuthorModelView {
  id: string;
  slug: string;
  display_name: string | null;
  description: string | null;
  status: string;
  enabled: boolean;
  current_author_version_id: string | null;
}
export interface AuthorVersionView {
  id: string;
  version_no: number;
  status: string;
  manifest_digest: string;
  endpoint_url: string;
  created_at: string;
  probe_state: string | null;
  probe_reviewed?: boolean;
  policy_id: string | null;
  policy_digest: string | null;
  price_microcredits: string | null;
  author_share_bps: number | null;
  availability_delay_seconds: number | null;
  rights_reference: string | null;
  consent_reference: string | null;
  accepted_at: string | null;
  approved_at: string | null;
}
export async function getAuthorModelView(
  id: string,
  actorId: string,
  admin = false,
) {
  const model = authorRows<AuthorModelView>(
    await db.execute(sql`SELECT id::text,slug,display_name,description,status,enabled,current_author_version_id::text
  FROM models WHERE id=${id}::uuid AND author_user_id IS NOT NULL AND (${admin}::boolean OR author_user_id=${actorId}::uuid)`),
  )[0];
  if (!model) return null;
  const versions = authorRows<AuthorVersionView>(
    await db.execute(sql`SELECT v.id::text,v.version_no,v.status,v.manifest_digest,coalesce(v.public_manifest#>>'{endpoint,url}','') AS endpoint_url,v.created_at::text,
  CASE WHEN probe.state='dispatching' AND probe.deadline_at<=clock_timestamp() THEN 'unknown' ELSE probe.state END AS probe_state,EXISTS(SELECT 1 FROM author_probe_operator_reviews review WHERE review.probe_id=probe.id) AS probe_reviewed,p.id::text AS policy_id,p.policy_digest,p.price_microcredits::text,p.author_share_bps,p.availability_delay_seconds,
  p.rights_reference,p.consent_reference,p.accepted_at::text,p.approved_at::text
  FROM author_model_versions v LEFT JOIN author_probe_operations probe ON probe.version_id=v.id LEFT JOIN author_price_policies p ON p.version_id=v.id
  WHERE v.model_id=${id}::uuid ORDER BY v.version_no DESC LIMIT 100`),
  );
  return { model, versions };
}
export async function getAuthorModerationQueue() {
  return authorRows<AuthorModelView & { candidate_count: number }>(
    await db.execute(sql`SELECT m.id::text,m.slug,m.display_name,m.description,m.status,m.enabled,m.current_author_version_id::text,
  (SELECT count(*)::int FROM author_model_versions v WHERE v.model_id=m.id AND v.status='candidate') AS candidate_count
  FROM models m WHERE m.author_user_id IS NOT NULL ORDER BY m.updated_at DESC LIMIT 100`),
  );
}
export interface AuthorBalance {
  available_microcredits: string;
  pending_microcredits: string;
  paid_microcredits: string;
  reserved_microcredits: string;
}
export interface AuthorEarningRow {
  billing_request_id: string;
  model_slug: string;
  version_no: number;
  kind: string;
  amount_microcredits: string;
  available_at: string;
  created_at: string;
  disputed: boolean;
}
export interface AuthorPayoutRow {
  id: string;
  state: string;
  amount_microcredits: string;
  recipient_reference: string;
  receipt_reference: string | null;
  created_at: string;
}
export async function getAuthorEarnings(actorId: string) {
  const balance = authorRows<AuthorBalance>(
    await db.execute(
      sql`SELECT * FROM aiag_author_credit_balance(${actorId}::uuid)`,
    ),
  )[0];
  if (!balance) throw Error("AUTHOR_BALANCE_UNAVAILABLE");
  const ledger = authorRows<AuthorEarningRow>(
    await db.execute(sql`SELECT l.billing_request_id::text,m.slug AS model_slug,v.version_no,l.kind,l.amount_microcredits::text,l.available_at::text,l.created_at::text,b.disputed
  FROM author_credit_ledger l JOIN author_request_bindings b USING(billing_request_id) JOIN author_model_versions v ON v.id=l.version_id JOIN models m ON m.id=b.model_id
  WHERE l.author_user_id=${actorId}::uuid ORDER BY l.created_at DESC LIMIT 100`),
  );
  const payouts = authorRows<AuthorPayoutRow>(
    await db.execute(sql`SELECT id::text,state,amount_microcredits::text,recipient_reference,receipt_reference,created_at::text
  FROM author_mock_payouts WHERE author_user_id=${actorId}::uuid ORDER BY created_at DESC LIMIT 30`),
  );
  return { balance, ledger, payouts };
}
export interface PublicAuthorModel {
  id: string;
  slug: string;
  display_name: string | null;
  description: string | null;
  version_id: string;
  version_no: number;
  manifest_digest: string;
  policy_id: string;
  policy_digest: string;
  price_microcredits: string;
}
export async function getPublicAuthorModels(slug?: string) {
  if (process.env.AUTHOR_CHAT_ENABLED !== "1") return [] as PublicAuthorModel[];
  return authorRows<PublicAuthorModel>(
    await db.execute(sql`SELECT m.id::text,m.slug,m.display_name,m.description,v.id::text AS version_id,v.version_no,v.manifest_digest,
  p.id::text AS policy_id,p.policy_digest,p.price_microcredits::text
  FROM models m JOIN author_model_versions v ON v.id=m.current_author_version_id AND v.model_id=m.id JOIN author_price_policies p ON p.version_id=v.id
  JOIN users u ON u.id=v.author_user_id JOIN author_probe_operations probe ON probe.version_id=v.id
  WHERE m.enabled AND m.status='live' AND v.status='approved' AND p.approved_at IS NOT NULL AND p.accepted_by=v.author_user_id AND probe.state='succeeded'
   AND u.is_active AND NOT u.is_banned AND (${slug ?? null}::text IS NULL OR m.slug=${slug ?? null}::text)
  ORDER BY m.updated_at DESC LIMIT 100`),
  );
}
