import { z } from 'zod';
import { API_URL } from './env.js';

/**
 * Bootstrap config the desktop app fetches once at startup, so it can
 * discover its identity provider at runtime instead of baking an issuer
 * into the build (see auth/providers.ts). Mirrors what RowBoat's desktop
 * did against its own hosted app (historical config/rowboat.ts, git commit
 * dd9e0668^) — same mechanism, new field names for the Dhow account.
 *
 * Loose on purpose: the server is free to add fields later (e.g. billing,
 * modelRecommendations, as RowboatApiConfig once carried) without breaking
 * older desktop builds. Zod already ignores unrecognized keys by default,
 * so nothing here needs to opt into that — only appUrl/supabaseUrl are read.
 */
const DhowApiConfigSchema = z.object({
  appUrl: z.url(),
  supabaseUrl: z.url(),
});

export type DhowApiConfig = z.infer<typeof DhowApiConfigSchema>;

let cached: DhowApiConfig | null = null;

/**
 * Fetches and caches the bootstrap config for the lifetime of the process.
 * The response never changes without a new build being shipped, so a single
 * fetch per launch is enough — this is not a request-scoped cache.
 */
export async function getDhowApiConfig(): Promise<DhowApiConfig> {
  if (cached) {
    return cached;
  }
  const response = await fetch(`${API_URL}/v1/config`);
  const data = DhowApiConfigSchema.parse(await response.json());
  cached = data;
  return data;
}
