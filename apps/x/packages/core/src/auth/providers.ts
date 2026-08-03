import { z } from 'zod';
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

  return config;
}

/**
 * Get list of all configured OAuth providers
 */
export function getAvailableProviders(): string[] {
  return Object.keys(providerConfigs);
}
