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
 * Dhow account (hosted sign-in) OAuth registration.
 *
 * The desktop client for the Dhow account is a Native/public client: PKCE,
 * no secret — same reasoning as the mail providers above. Unset by default,
 * which leaves "Sign in with Dhow" unavailable and the app bring-your-own-key
 * throughout. Set at build time to enable the hosted account.
 *
 * DHOW_ISSUER is the tenant that mints account tokens. It defaults to the
 * production custom domain; point it at a development tenant locally. The
 * default is only ever reached once DHOW_ACCOUNT_CLIENT_ID is also set, so an
 * unprovisioned domain cannot surface as a confusing discovery failure.
 *
 * DHOW_API_AUDIENCE must match the API identifier registered in the tenant.
 * Without an audience Auth0 issues an opaque access token, which the model
 * gateway cannot validate — so this is required, not cosmetic.
 */
export const DHOW_ACCOUNT_CLIENT_ID = process.env.DHOW_ACCOUNT_CLIENT_ID || undefined;
export const DHOW_ISSUER = process.env.DHOW_ISSUER || 'https://auth.dhow.io';
export const DHOW_API_AUDIENCE = process.env.DHOW_API_AUDIENCE || 'https://api.dhow.io';

/**
 * Hosted model gateway. OpenAI-compatible, bearer-authorized by the Dhow
 * account session. Overridable so a local gateway can be pointed at during
 * development without rebuilding.
 */
export const DHOW_GATEWAY_BASE_URL = process.env.DHOW_GATEWAY_BASE_URL || 'https://api.dhow.io/v1';
