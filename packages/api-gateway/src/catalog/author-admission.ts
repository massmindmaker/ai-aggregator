import type postgres from 'postgres';
import { config } from '../config';

/**
 * The tagged-template overload shared by the client singleton and its
 * transactions, taken from the driver types so the fragment keeps its exact
 * `PendingQuery` result instead of collapsing to `unknown`.
 */
export type SqlFragmentSource = (
  template: TemplateStringsArray,
  ...parameters: readonly postgres.ParameterOrFragment<never>[]
) => postgres.PendingQuery<readonly postgres.Row[]>;

/**
 * Single admission authority for author versions.
 *
 * Both public listings (`GET /v1/models` and `GET /v1/catalog`) must agree on
 * exactly which author versions are sold. Duplicating this predicate is how the
 * two lists drifted apart in the first place, so both read it from here.
 *
 * The fragment is built with the caller's own client, so the process flag stays
 * a bound parameter and the predicate text itself is a module constant.
 */
export function authorVersionListed(client: SqlFragmentSource) {
  return client`(m.author_user_id IS NULL OR (
    ${config.AUTHOR_CHAT_ENABLED === '1'}::boolean
    AND m.status = 'live'
    AND m.author_user_id IS NOT NULL
    AND v.status = 'approved'
    AND v.author_user_id = m.author_user_id
    AND p.approved_at IS NOT NULL
    AND p.accepted_by = v.author_user_id
    AND EXISTS (SELECT 1 FROM author_probe_operations probe
                 WHERE probe.version_id = v.id AND probe.state = 'succeeded')
    AND EXISTS (SELECT 1 FROM users u
                 WHERE u.id = v.author_user_id AND u.is_active AND NOT u.is_banned)
  ))`;
}

/** True when the author execution contract is enabled process-wide. */
export function authorChatEnabled(): boolean {
  return config.AUTHOR_CHAT_ENABLED === '1';
}
