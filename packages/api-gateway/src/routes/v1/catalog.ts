import { Hono } from 'hono';
import { PublicCatalogError, readPublicCatalog } from '../../catalog/public-catalog';
import {
  captureCatalogHttpRequest,
  catalogHttpErrors,
  respondCatalogHttpError,
} from '../../catalog/http-contract';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

export const catalogRoute = new Hono();

catalogRoute.get('/', async (c) => {
  const request = captureCatalogHttpRequest(c.req.url);
  if ('code' in request) return respondCatalogHttpError(c, request);
  const key = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  if (!key) return respondCatalogHttpError(c, catalogHttpErrors.catalogUnavailable);
  try {
    const response = await readPublicCatalog({ key, ...request });
    c.header('Vary', 'Authorization');
    return c.json(response);
  } catch (error) {
    if (error instanceof PublicCatalogError) {
      if (error.kind === 'key_policy_unavailable')
        return respondCatalogHttpError(c, catalogHttpErrors.keyPolicyUnavailable);
      if (error.kind === 'revision_changed')
        return respondCatalogHttpError(c, catalogHttpErrors.revisionChanged);
    }
    return respondCatalogHttpError(c, catalogHttpErrors.catalogUnavailable);
  }
});
