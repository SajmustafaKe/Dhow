import { WorkDir } from '../config/config.js';
import fs from 'fs/promises';
import path from 'path';
import { OAuthTokens } from './types.js';
import z from 'zod';

/**
 * One authorized mailbox/identity under a provider.
 *
 * Split from the provider record because the two have different lifetimes: a
 * BYOK app registration (clientId/clientSecret) is registered once and can
 * authorize many accounts, while tokens are per-account and are revoked
 * independently.
 */
const AccountConnectionSchema = z.object({
  tokens: OAuthTokens.nullable().optional(),
  /** Display label — the address as reported by the provider at connect time. */
  email: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  addedAt: z.number().optional(),
});
export type AccountConnection = z.infer<typeof AccountConnectionSchema>;

const ProviderConnectionSchema = z.object({
  /**
   * App registration — provider-wide, shared by every account beneath it.
   * `byok` (default for absent) — user provides their own client_id+secret;
   * tokens stored locally; refresh handled locally via openid-client.
   * `dhow` — signed-in user; client_id+secret never on the desktop;
   * tokens stored locally but refresh goes through the api.
   */
  clientId: z.string().nullable().optional(),
  clientSecret: z.string().nullable().optional(),
  mode: z.enum(['byok', 'dhow']).optional(),
  accounts: z.record(z.string(), AccountConnectionSchema).default({}),
  /**
   * Which account answers requests that name no account — calendar, docs and
   * agent notes are single-identity surfaces and resolve through this.
   * Invariant: non-null whenever `accounts` is non-empty (see pruneProvider).
   */
  primaryAccountId: z.string().nullable().optional(),
});

const OAuthConfigSchema = z.object({
  version: z.number().optional(),
  providers: z.record(z.string(), ProviderConnectionSchema),
});

const ClientFacingConfigSchema = z.record(z.string(), z.object({
  connected: z.boolean(),
  error: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  primaryAccountId: z.string().nullable().optional(),
  accounts: z.array(z.object({
    id: z.string(),
    email: z.string().nullable().optional(),
    connected: z.boolean(),
    error: z.string().nullable().optional(),
  })),
}));

/** v1: bare provider -> tokens. */
const LegacyOauthConfigSchema = z.record(z.string(), OAuthTokens);

/** v2: provider -> { tokens, clientId, clientSecret, mode, error }, one account implied. */
const V2ProviderSchema = z.object({
  tokens: OAuthTokens.nullable().optional(),
  clientId: z.string().nullable().optional(),
  clientSecret: z.string().nullable().optional(),
  mode: z.enum(['byok', 'dhow']).optional(),
  error: z.string().nullable().optional(),
});
const V2ConfigSchema = z.object({
  version: z.literal(2).optional(),
  providers: z.record(z.string(), V2ProviderSchema),
});

/**
 * Account id for a connection migrated from v2. Opaque and permanent: the
 * provider's stable subject id is only knowable from a live grant, and a
 * migration must not make network calls, so the pre-existing account keeps
 * this id for good. Ids are never parsed — only the `email` label is shown.
 */
export const LEGACY_ACCOUNT_ID = 'default';

export const CONFIG_VERSION = 3;

const DEFAULT_CONFIG: z.infer<typeof OAuthConfigSchema> = {
  version: CONFIG_VERSION,
  providers: {},
};

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;
export type ClientFacingConfig = z.infer<typeof ClientFacingConfigSchema>;

export interface IOAuthRepo {
  /** Provider-level record: app registration plus every account beneath it. */
  read(provider: string): Promise<ProviderConnection>;
  /** Update provider-level fields only (clientId/clientSecret/mode). Never touches accounts. */
  upsert(provider: string, connection: Partial<Omit<ProviderConnection, 'accounts'>>): Promise<void>;
  /** Remove the provider entirely, including every account. */
  delete(provider: string): Promise<void>;

  /** One account's record, or `{}` when absent. */
  readAccount(provider: string, accountId: string): Promise<AccountConnection>;
  /**
   * Create or update one account. The first account added to a provider
   * becomes its primary.
   */
  upsertAccount(provider: string, accountId: string, account: Partial<AccountConnection>): Promise<void>;
  /**
   * Remove one account. When it was the primary, another is promoted so the
   * provider never has accounts without a primary; removing the last account
   * leaves the app registration intact so the user need not re-enter it.
   */
  deleteAccount(provider: string, accountId: string): Promise<void>;
  /** Account ids in insertion order. */
  listAccounts(provider: string): Promise<string[]>;
  /** The primary account id, or null when the provider has no accounts. */
  getPrimaryAccountId(provider: string): Promise<string | null>;
  setPrimaryAccountId(provider: string, accountId: string): Promise<void>;

  getClientFacingConfig(): Promise<ClientFacingConfig>;
}

export class FSOAuthRepo implements IOAuthRepo {
  private readonly configPath = path.join(WorkDir, 'config', 'oauth.json');

  constructor() {
    this.ensureConfigFile();
  }

  private async ensureConfigFile(): Promise<void> {
    try {
      await fs.access(this.configPath);
    } catch {
      await fs.writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }
  }

  /**
   * Bring any on-disk shape up to v3. Ordered newest-first so the common case
   * (already current) costs one parse. Every older shape converges on v3 via
   * `liftV2`, including v1, which is first widened to v2.
   */
  private normalizeConfig(payload: unknown): { config: z.infer<typeof OAuthConfigSchema>; migrated: boolean } {
    const current = OAuthConfigSchema.safeParse(payload);
    if (current.success && current.data.version === CONFIG_VERSION) {
      return { config: current.data, migrated: false };
    }

    const v2 = V2ConfigSchema.safeParse(payload);
    if (v2.success) {
      return { config: this.liftV2(v2.data.providers), migrated: true };
    }

    const v1 = LegacyOauthConfigSchema.safeParse(payload);
    if (v1.success) {
      const widened: Record<string, z.infer<typeof V2ProviderSchema>> = {};
      for (const [provider, tokens] of Object.entries(v1.data)) {
        widened[provider] = { tokens };
      }
      return { config: this.liftV2(widened), migrated: true };
    }

    // Unrecognized payload: a current-shaped config missing only its version
    // stamp still parses above, so reaching here means the file is corrupt.
    // Refuse to guess — start clean rather than silently drop credentials
    // into a half-read state.
    if (current.success) return { config: { ...current.data, version: CONFIG_VERSION }, migrated: true };
    return { config: { ...DEFAULT_CONFIG }, migrated: false };
  }

  /**
   * v2 -> v3. The single implied connection becomes one account under
   * LEGACY_ACCOUNT_ID and is made primary; the app registration stays at
   * provider level. A provider carrying credentials but no tokens (registered
   * but never authorized) yields no account at all.
   */
  private liftV2(providers: Record<string, z.infer<typeof V2ProviderSchema>>): z.infer<typeof OAuthConfigSchema> {
    const config: z.infer<typeof OAuthConfigSchema> = { version: CONFIG_VERSION, providers: {} };
    for (const [provider, v2] of Object.entries(providers)) {
      const hasGrant = !!v2.tokens;
      config.providers[provider] = {
        clientId: v2.clientId,
        clientSecret: v2.clientSecret,
        mode: v2.mode,
        accounts: hasGrant
          ? { [LEGACY_ACCOUNT_ID]: { tokens: v2.tokens, error: v2.error, addedAt: Date.now() } }
          : {},
        primaryAccountId: hasGrant ? LEGACY_ACCOUNT_ID : null,
      };
    }
    return config;
  }

  private async readConfig(): Promise<z.infer<typeof OAuthConfigSchema>> {
    try {
      const content = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(content);
      const { config, migrated } = this.normalizeConfig(parsed);
      if (migrated) {
        await this.writeConfig(config);
      }
      return config;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private async writeConfig(config: z.infer<typeof OAuthConfigSchema>): Promise<void> {
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
  }

  private emptyProvider(): ProviderConnection {
    return { accounts: {}, primaryAccountId: null };
  }

  async read(provider: string): Promise<ProviderConnection> {
    const config = await this.readConfig();
    return config.providers[provider] ?? this.emptyProvider();
  }

  async upsert(provider: string, connection: Partial<Omit<ProviderConnection, 'accounts'>>): Promise<void> {
    const config = await this.readConfig();
    const existing = config.providers[provider] ?? this.emptyProvider();
    // `accounts` is spread last from the existing record: callers of the
    // provider-level upsert must never be able to clobber grants.
    config.providers[provider] = { ...existing, ...connection, accounts: existing.accounts };
    await this.writeConfig(config);
  }

  async delete(provider: string): Promise<void> {
    const config = await this.readConfig();
    delete config.providers[provider];
    await this.writeConfig(config);
  }

  async readAccount(provider: string, accountId: string): Promise<AccountConnection> {
    const config = await this.readConfig();
    return config.providers[provider]?.accounts[accountId] ?? {};
  }

  async upsertAccount(provider: string, accountId: string, account: Partial<AccountConnection>): Promise<void> {
    const config = await this.readConfig();
    const existing = config.providers[provider] ?? this.emptyProvider();
    const prior = existing.accounts[accountId];
    existing.accounts[accountId] = {
      ...prior,
      ...account,
      addedAt: prior?.addedAt ?? account.addedAt ?? Date.now(),
    };
    // First account in becomes primary, so a provider with grants always has one.
    if (!existing.primaryAccountId) existing.primaryAccountId = accountId;
    config.providers[provider] = existing;
    await this.writeConfig(config);
  }

  async deleteAccount(provider: string, accountId: string): Promise<void> {
    const config = await this.readConfig();
    const existing = config.providers[provider];
    if (!existing) return;
    delete existing.accounts[accountId];
    if (existing.primaryAccountId === accountId) {
      // Promote rather than leave a dangling pointer — every remaining
      // account-less request must still resolve.
      existing.primaryAccountId = Object.keys(existing.accounts)[0] ?? null;
    }
    // The app registration outlives its accounts: disconnecting the last
    // mailbox should not force the user to re-enter their client id/secret.
    config.providers[provider] = existing;
    await this.writeConfig(config);
  }

  async listAccounts(provider: string): Promise<string[]> {
    const config = await this.readConfig();
    return Object.keys(config.providers[provider]?.accounts ?? {});
  }

  async getPrimaryAccountId(provider: string): Promise<string | null> {
    const config = await this.readConfig();
    const existing = config.providers[provider];
    if (!existing) return null;
    // Tolerate a primary pointing at a removed account.
    if (existing.primaryAccountId && existing.accounts[existing.primaryAccountId]) {
      return existing.primaryAccountId;
    }
    return Object.keys(existing.accounts)[0] ?? null;
  }

  async setPrimaryAccountId(provider: string, accountId: string): Promise<void> {
    const config = await this.readConfig();
    const existing = config.providers[provider];
    if (!existing || !existing.accounts[accountId]) {
      throw new Error(`Cannot set primary: ${provider} has no account ${accountId}`);
    }
    existing.primaryAccountId = accountId;
    await this.writeConfig(config);
  }

  async getClientFacingConfig(): Promise<ClientFacingConfig> {
    const config = await this.readConfig();
    const clientFacingConfig: ClientFacingConfig = {};
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      const accounts = Object.entries(providerConfig.accounts).map(([id, account]) => ({
        id,
        email: account.email ?? null,
        connected: !!account.tokens,
        error: account.error ?? null,
      }));
      const primary = accounts.find((a) => a.id === providerConfig.primaryAccountId) ?? accounts[0];
      clientFacingConfig[provider] = {
        // `connected` stays whole-provider so existing single-account callers
        // keep working: true when any account holds a grant.
        connected: accounts.some((a) => a.connected),
        error: primary?.error ?? null,
        clientId: providerConfig.clientId ?? null,
        primaryAccountId: providerConfig.primaryAccountId ?? null,
        accounts,
      };
    }
    return ClientFacingConfigSchema.parse(clientFacingConfig);
  }
}