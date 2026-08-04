// GitHub OAuth app used for Apps publishing (device flow, public_repo scope).
// Client IDs are public identifiers, not secrets (spec §3).
export const GITHUB_OAUTH_CLIENT_ID =
  process.env.DHOW_GITHUB_CLIENT_ID || 'Ov23liAka106zKEovj4B';

/**
 * Mail-provider OAuth credentials shipped with the build.
 *
 * Unset by default, which leaves each provider in bring-your-own-credentials
 * mode: the user registers their own app and pastes the client ID. Set these
 * at build time to ship one registration instead, and the connect button
 * works with no console visit.
 *
 * A desktop client cannot keep a secret — anything in the bundle is readable.
 * Google says so plainly for installed apps ("the client secret is obviously
 * not treated as a secret"), and the flow is protected by PKCE, not by the
 * secret. Ship one only because Google's *web application* client type
 * demands it at the token endpoint; a *desktop* client type needs no secret
 * and is the better choice where it is an option.
 */
export const GOOGLE_OAUTH_CLIENT_ID = process.env.DHOW_GOOGLE_CLIENT_ID || undefined;
export const GOOGLE_OAUTH_CLIENT_SECRET = process.env.DHOW_GOOGLE_CLIENT_SECRET || undefined;
export const MICROSOFT_OAUTH_CLIENT_ID = process.env.DHOW_MICROSOFT_CLIENT_ID || undefined;

/**
 * Base URL of the hosted Dhow web app's API, used to bootstrap the desktop
 * client's identity provider at runtime: `GET ${API_URL}/v1/config` returns
 * `{ appUrl, supabaseUrl }`, and `supabaseUrl` is what auth/providers.ts
 * resolves the "dhow" OIDC issuer from. This is the mechanism RowBoat used
 * for its own hosted app (historical config/rowboat.ts) — resolving the
 * issuer at runtime means changing identity provider, or rotating the
 * Supabase project, never requires shipping a new desktop build.
 *
 * Includes the `/api` segment: the endpoint is a Next.js app-router route
 * served at `/api/v1/config`, not `/v1/config`. Overridable so a local
 * `apps/dhowx` dev server can be pointed at without rebuilding.
 */
export const API_URL = process.env.DHOW_API_URL || 'https://dhow.io/api';

/**
 * Hosted model gateway. OpenAI-compatible, bearer-authorized by the Dhow
 * account session. Overridable so a local gateway can be pointed at during
 * development without rebuilding.
 */
export const DHOW_GATEWAY_BASE_URL = process.env.DHOW_GATEWAY_BASE_URL || 'https://api.dhow.io/v1';
