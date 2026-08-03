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
