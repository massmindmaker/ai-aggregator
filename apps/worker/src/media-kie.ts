import { KieAdapter } from '@aiag/upstream-adapters';

type MediaKieEnv = Readonly<Record<string, string | undefined>>;

export function createMediaKieAdapter(
  env: MediaKieEnv = process.env,
  fetchOverride?: typeof fetch,
): KieAdapter | null {
  const apiKey = env.KIE_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl = env.KIE_BASE_URL?.trim();
  return new KieAdapter({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
}
