import { z } from 'zod';
import * as dhowApi from '../config/dhow-api.js';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  MICROSOFT_OAUTH_CLIENT_ID,
} from '../config/env.js';

/**
 * Discovery configuration - how to get OAuth endpoints
 */
const DiscoverySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('issuer'),
    issuer: z.url().describe('The issuer base url. To discover the endpoints, the client will fetch the .well-known/oauth-authorization-server from this url.'),
  }),
  z.object({
    mode: z.literal('static'),
    authorizationEndpoint: z.url(),
    tokenEndpoint: z.url(),
    revocationEndpoint: z.url().optional(),
  }),
]);

/**
 * Client configuration - how to get client credentials
 */
const ClientSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('static'),
    // Absent -> the user supplies their own registration (see env.ts).
    clientId: z.string().min(1).optional(),
    // Only meaningful alongside a shipped clientId, and only for providers
    // whose token endpoint insists on one. Not a secret in a desktop build.
    clientSecret: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal('dcr'),
    // If omitted, should be discovered from auth-server metadata as `registration_endpoint`
    registrationEndpoint: z.url().optional(),
  }),
]);

/**
 * Provider configuration schema
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ProviderConfigSchema = z.record(
  z.string(),
  z.object({
    discovery: DiscoverySchema,
    client: ClientSchema,
    scopes: z.array(z.string()).optional(),
  })
);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderConfigEntry = ProviderConfig[string];

/**
 * All configured OAuth providers
 */
const providerConfigs: ProviderConfig = {
  // The Dhow account itself — an identity, not a mailbox. Signing in here is
  // what enables the hosted model gateway and, later, a shipped mail
  // registration; it never reads mail on its own. Kept first so the
  // account/mailbox distinction is visible at a glance: every other entry
  // below authorizes access to a third-party inbox or transcript service.
  //
  // Supabase Auth (GoTrue) is the identity provider for both desktop and
  // web — one IdP, one user table. The issuer is not known at build time:
  // it is resolved at call time in getProviderConfig from the hosted app's
  // runtime bootstrap (config/dhow-api.ts), exactly as RowBoat resolved its
  // own issuer (historical config/rowboat.ts). That is deliberate: it means
  // changing IdP or Supabase project never requires shipping a new build.
  // Dynamic Client Registration replaces the static client id for the same
  // reason — a desktop build carries no registration to ship.
  dhow: {
    discovery: {
      mode: 'issuer',
      // Overwritten in getProviderConfig before this is ever read.
      issuer: 'TBD',
    },
    client: {
      mode: 'dcr',
    },
    // `offline_access` is restored after checking the live tenant: GoTrue's
    // discovery document at
    // https://<ref>.supabase.co/auth/v1/.well-known/openid-configuration
    // lists it in `scopes_supported`. It was dropped earlier as an
    // "Auth0-ism", which was wrong — it is the standard OIDC way to request a
    // refresh token, and the risk is asymmetric: including it when
    // unnecessary costs nothing, omitting it when required means no refresh
    // token and users silently signed out when the access token expires.
    scopes: ['openid', 'email', 'profile', 'offline_access'],
  },
  google: {
    discovery: {
      mode: 'issuer',
      issuer: 'https://accounts.google.com',
    },
    client: {
      mode: 'static',
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    },
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      // Per-file Drive access (non-restricted): the user grants read/write to a
      // specific doc by choosing it in the Google Picker. Enough to export/
      // download and write back, without the restricted full-drive scope.
      'https://www.googleapis.com/auth/drive.file',
    ],
  },
  microsoft: {
    discovery: {
      mode: 'issuer',
      // The multi-tenant endpoint: covers personal Outlook/Hotmail/Live
      // accounts and work or school Microsoft 365 tenants with one
      // registration. A single-tenant app would swap `common` for its
      // tenant id.
      issuer: 'https://login.microsoftonline.com/common/v2.0',
    },
    client: {
      mode: 'static',
      clientId: MICROSOFT_OAUTH_CLIENT_ID,
    },
    scopes: [
      // Entra only returns a refresh token when this is asked for explicitly —
      // unlike Google, where offline access is a separate parameter.
      'offline_access',
      'openid',
      'profile',
      'email',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
      // Read-only, matching the Google side. No admin consent needed for
      // personal accounts; work tenants already gate Mail.ReadWrite anyway.
      'https://graph.microsoft.com/Calendars.Read',
    ],
  },
  'fireflies-ai': {
    discovery: {
      mode: 'issuer',
      issuer: 'https://api.fireflies.ai/.well-known/oauth-authorization-server',
    },
    client: {
      mode: 'dcr',
    },
    scopes: [
      'profile',
      'email',
    ]
  }
};

/**
 * Get provider configuration by name
 */
export async function getProviderConfig(providerName: string): Promise<ProviderConfigEntry> {
  const config = providerConfigs[providerName];
  if (!config) {
    throw new Error(`Unknown OAuth provider: ${providerName}`);
  }
  if (providerName === 'dhow') {
    const { supabaseUrl } = await dhowApi.getDhowApiConfig();
    config.discovery = {
      mode: 'issuer',
      issuer: `${supabaseUrl}/auth/v1/.well-known/oauth-authorization-server`,
    };
  }
  return config;
}

/**
 * Get list of all configured OAuth providers
 */
export function getAvailableProviders(): string[] {
  return Object.keys(providerConfigs);
}
