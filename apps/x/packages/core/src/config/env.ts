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
 * KEEPS THE `/api` SEGMENT even though the host is already `api.dhow.io`,
 * and the redundancy is deliberate. `api.dhow.io/v1/*` is NOT free: it is
 * the model gateway's namespace — DHOW_GATEWAY_BASE_URL below points there,
 * models/dhow.ts hands it to an OpenAI client as a baseURL, and that client
 * calls /v1/chat/completions, /v1/models and /v1/models/user. Serving the
 * web app at /v1 would put the two on a collision course the first time the
 * gateway ships.
 *
 * So the host carries two namespaces:
 *   api.dhow.io/api/*  -> apps/dhowx  (this constant)
 *   api.dhow.io/v1/*   -> model gateway (DHOW_GATEWAY_BASE_URL)
 *
 * The path also matches Next's app router exactly — the route file lives at
 * app/api/v1/config/route.ts and is served at /api/v1/config — so the nginx
 * vhost is a straight proxy with no rewrite to get wrong.
 *
 * Overridable so a local `apps/dhowx` dev server can be pointed at without
 * rebuilding: DHOW_API_URL=http://localhost:3000/api
 */
export const API_URL = process.env.DHOW_API_URL || 'https://api.dhow.io/api';

/**
 * Hosted model gateway. OpenAI-compatible, bearer-authorized by the Dhow
 * account session. Overridable so a local gateway can be pointed at during
 * development without rebuilding.
 */
export const DHOW_GATEWAY_BASE_URL = process.env.DHOW_GATEWAY_BASE_URL || 'https://api.dhow.io/v1';
