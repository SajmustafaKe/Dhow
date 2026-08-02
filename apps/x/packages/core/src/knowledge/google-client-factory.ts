import { OAuth2Client } from 'google-auth-library';
import container from '../di/container.js';
import { IOAuthRepo } from '../auth/repo.js';
import { IClientRegistrationRepo } from '../auth/client-repo.js';
import { getProviderConfig } from '../auth/providers.js';
import * as oauthClient from '../auth/oauth-client.js';
import type { Configuration } from '../auth/oauth-client.js';
import { OAuthTokens } from '../auth/types.js';

/**
 * Factory for creating and managing Google OAuth2Client instances.
 * Handles caching, token refresh, and client reuse for Google API SDKs.
 *
 * One connection mode: the user supplies their own Google OAuth
 * `client_id` (+ optional secret) — see google-setup.md. Refresh runs
 * locally via openid-client, and the OAuth2Client is built with those
 * credentials plus the refresh_token, so the library can also refresh on
 * its own if a call races our proactive expiry check.
 */
export class GoogleClientFactory {
    private static readonly PROVIDER_NAME = 'google';

    /**
     * Provider-wide state. The discovered OIDC Configuration and the BYOK app
     * registration are shared by every account — one Google Cloud app
     * authorizes many mailboxes — so re-discovering them per account would be
     * pure waste.
     */
    private static shared: {
        config: Configuration | null;
        clientId: string | null;
        clientSecret: string | null;
    } = { config: null, clientId: null, clientSecret: null };

    /**
     * Per-account state. Accounts refresh independently: one expired grant
     * must not invalidate another account's live client.
     */
    private static accounts = new Map<string, { client: OAuth2Client | null; tokens: OAuthTokens | null }>();

    /**
     * Promise singletons so concurrent getClient() callers share a single
     * pass through the read/refresh/build pipeline rather than fanning
     * out parallel refreshes. The check-and-assign must be atomic (no
     * `await` between them) so two callers in the same tick can't both
     * pass the null check before either assigns — that's why getClient()
     * is a thin synchronous wrapper around getClientInner().
     *
     * Keyed by account: two callers for the SAME account coalesce, while two
     * different accounts proceed in parallel.
     */
    private static inFlightClient = new Map<string, Promise<OAuth2Client | null>>();

    private static accountState(accountId: string): { client: OAuth2Client | null; tokens: OAuthTokens | null } {
        let state = this.accounts.get(accountId);
        if (!state) {
            state = { client: null, tokens: null };
            this.accounts.set(accountId, state);
        }
        return state;
    }

    /** Account ids with a grant under this provider. */
    static async listAccountIds(): Promise<string[]> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        return oauthRepo.listAccounts(this.PROVIDER_NAME);
    }

    /**
     * Resolve an explicit account, or the primary when none is named.
     * Calendar, Docs and agent notes are single-identity surfaces and rely on
     * this defaulting to keep working unchanged.
     */
    private static async resolveAccountId(accountId?: string): Promise<string | null> {
        if (accountId) return accountId;
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        return oauthRepo.getPrimaryAccountId(this.PROVIDER_NAME);
    }

    private static async resolveByokCredentials(): Promise<{ clientId: string; clientSecret?: string }> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const connection = await oauthRepo.read(this.PROVIDER_NAME);
        if (!connection.clientId) {
            throw new Error('Google client ID missing. Please reconnect.');
        }
        return { clientId: connection.clientId, clientSecret: connection.clientSecret ?? undefined };
    }

    /**
     * Get or create OAuth2Client for one account, reusing the cached instance
     * when possible. Omit `accountId` to use the primary account.
     *
     * The check-and-assign of `inFlightClient` is synchronous so concurrent
     * callers in the same tick coalesce onto a single pipeline run. The actual
     * work lives in getClientInner(); this wrapper exists purely to guarantee
     * the dedup invariant.
     */
    static async getClient(accountId?: string): Promise<OAuth2Client | null> {
        const resolved = await this.resolveAccountId(accountId);
        if (!resolved) return null;

        const existing = this.inFlightClient.get(resolved);
        if (existing) {
            return existing;
        }
        const pending = this.getClientInner(resolved).finally(() => {
            this.inFlightClient.delete(resolved);
        });
        this.inFlightClient.set(resolved, pending);
        return pending;
    }

    private static async getClientInner(accountId: string): Promise<OAuth2Client | null> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const account = await oauthRepo.readAccount(this.PROVIDER_NAME, accountId);
        const tokens = account.tokens ?? null;

        if (!tokens) {
            this.clearCache(accountId);
            return null;
        }

        // Local refresh needs an openid-client Configuration.
        try {
            await this.initializeConfigCache();
        } catch (error) {
            console.error('[OAuth] Failed to initialize Google OAuth configuration:', error);
            this.clearCache(accountId);
            return null;
        }
        if (!this.shared.config) {
            return null;
        }

        // Check expiry against the cached tokens. Note: oauthClient.isTokenExpired
        // applies a small clock-skew margin so we refresh slightly before real
        // expiry — keeps long-running calls from racing the boundary.
        if (oauthClient.isTokenExpired(tokens)) {
            if (!tokens.refresh_token) {
                console.log(`[OAuth] Google token expired for ${accountId} and no refresh token available.`);
                await oauthRepo.upsertAccount(this.PROVIDER_NAME, accountId, { error: 'Missing refresh token. Please reconnect.' });
                this.clearCache(accountId);
                return null;
            }
            return this.refreshAndBuild(accountId, tokens);
        }

        // Reuse client if tokens haven't changed
        const state = this.accountState(accountId);
        if (state.client && state.tokens && state.tokens.access_token === tokens.access_token) {
            return state.client;
        }

        // Build a fresh client for current tokens
        return this.buildAndCacheClient(accountId, tokens);
    }

    private static async refreshAndBuild(accountId: string, tokens: OAuthTokens): Promise<OAuth2Client | null> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');

        try {
            const secsSinceExpiry = Math.floor(Date.now() / 1000) - tokens.expires_at;
            console.log(`[OAuth] Google token for ${accountId} expired ${secsSinceExpiry}s ago, refreshing...`);
            const existingScopes = tokens.scopes;

            if (!this.shared.config) {
                // Should not happen — initializeConfigCache ran above.
                throw new Error('Google OAuth config not initialized');
            }
            const refreshedTokens = await oauthClient.refreshTokens(this.shared.config, tokens.refresh_token!, existingScopes);

            await oauthRepo.upsertAccount(this.PROVIDER_NAME, accountId, { tokens: refreshedTokens, error: null });
            const ttl = refreshedTokens.expires_at - Math.floor(Date.now() / 1000);
            console.log(`[OAuth] Google token refreshed successfully for ${accountId} (new expires_at=${refreshedTokens.expires_at}, ttl=${ttl}s)`);
            return this.buildAndCacheClient(accountId, refreshedTokens);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to refresh token for Google';
            await oauthRepo.upsertAccount(this.PROVIDER_NAME, accountId, { error: message });
            console.error(`[OAuth] Failed to refresh token for Google account ${accountId}:`, error);
            // Walk cause chain so a specific failure isn't hidden under a
            // generic `fetch failed` outer error.
            let cause: unknown = error;
            while (cause != null && typeof cause === 'object' && 'cause' in cause) {
                cause = (cause as { cause?: unknown }).cause;
                if (cause != null) console.error('[OAuth] Caused by:', cause);
            }
            // Scoped to this account: a revoked grant on one mailbox must not
            // drop the discovered config or the other accounts' live clients.
            this.clearCache(accountId);
            return null;
        }
    }

    private static async buildAndCacheClient(accountId: string, tokens: OAuthTokens): Promise<OAuth2Client> {
        if (!this.shared.clientId) {
            const creds = await this.resolveByokCredentials();
            this.shared.clientId = creds.clientId;
            this.shared.clientSecret = creds.clientSecret ?? null;
        }

        const client = this.createByokClient(tokens, this.shared.clientId!, this.shared.clientSecret ?? undefined);

        const state = this.accountState(accountId);
        state.tokens = tokens;
        state.client = client;
        return client;
    }

    /**
     * Check if credentials are available and have required scopes.
     * Omit `accountId` to check the primary account.
     */
    static async hasValidCredentials(requiredScopes: string | string[], accountId?: string): Promise<boolean> {
        const status = await this.getCredentialStatus(requiredScopes, accountId);
        return status.hasRequiredScopes;
    }

    static async getCredentialStatus(requiredScopes: string | string[], accountId?: string): Promise<{
        connected: boolean;
        hasRequiredScopes: boolean;
        missingScopes: string[];
    }> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const resolved = await this.resolveAccountId(accountId);
        const tokens = resolved
            ? (await oauthRepo.readAccount(this.PROVIDER_NAME, resolved)).tokens ?? null
            : null;
        if (!tokens) {
            const scopesArray = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
            return {
                connected: false,
                hasRequiredScopes: false,
                missingScopes: scopesArray,
            };
        }

        const scopesArray = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
        const granted = new Set(tokens.scopes ?? []);
        const missingScopes = scopesArray.filter(scope => !granted.has(scope));
        if (!tokens.scopes || tokens.scopes.length === 0) {
            return {
                connected: true,
                hasRequiredScopes: false,
                missingScopes,
            };
        }
        return {
            connected: true,
            hasRequiredScopes: missingScopes.length === 0,
            missingScopes,
        };
    }

    /**
     * Clear cached clients. Omit `accountId` to clear every account plus the
     * provider-wide config and credentials; pass one to evict just that
     * account, leaving other mailboxes connected.
     */
    static clearCache(accountId?: string): void {
        if (accountId) {
            console.log(`[OAuth] Clearing Google auth cache for ${accountId}`);
            this.accounts.delete(accountId);
            return;
        }
        console.log('[OAuth] Clearing Google auth cache');
        this.accounts.clear();
        this.shared.config = null;
        this.shared.clientId = null;
        this.shared.clientSecret = null;
    }

    /**
     * Initialize the cached openid-client Configuration used for local refresh.
     */
    private static async initializeConfigCache(): Promise<void> {
        const { clientId, clientSecret } = await this.resolveByokCredentials();

        if (this.shared.config && this.shared.clientId === clientId && this.shared.clientSecret === (clientSecret ?? null)) {
            return; // Already initialized for these credentials
        }

        if (this.shared.clientId && (this.shared.clientId !== clientId || this.shared.clientSecret !== (clientSecret ?? null))) {
            this.clearCache();
        }

        console.log('[OAuth] Initializing Google OAuth configuration...');
        const providerConfig = await getProviderConfig(this.PROVIDER_NAME);

        if (providerConfig.discovery.mode === 'issuer') {
            if (providerConfig.client.mode === 'static') {
                // Discover endpoints, use static client ID
                console.log('[OAuth] Discovery mode: issuer with static client ID');
                this.shared.config = await oauthClient.discoverConfiguration(
                    providerConfig.discovery.issuer,
                    clientId,
                    clientSecret
                );
            } else {
                // DCR mode - need existing registration
                console.log('[OAuth] Discovery mode: issuer with DCR');
                const clientRepo = container.resolve<IClientRegistrationRepo>('clientRegistrationRepo');
                const existingRegistration = await clientRepo.getClientRegistration(this.PROVIDER_NAME);

                if (!existingRegistration) {
                    throw new Error('Google client not registered. Please connect account first.');
                }

                this.shared.config = await oauthClient.discoverConfiguration(
                    providerConfig.discovery.issuer,
                    existingRegistration.client_id
                );
            }
        } else {
            // Static endpoints
            if (providerConfig.client.mode !== 'static') {
                throw new Error('DCR requires discovery mode "issuer", not "static"');
            }

            console.log('[OAuth] Using static endpoints (no discovery)');
            this.shared.config = oauthClient.createStaticConfiguration(
                providerConfig.discovery.authorizationEndpoint,
                providerConfig.discovery.tokenEndpoint,
                clientId,
                providerConfig.discovery.revocationEndpoint,
                clientSecret
            );
        }

        this.shared.clientId = clientId;
        this.shared.clientSecret = clientSecret ?? null;
        console.log('[OAuth] Google OAuth configuration initialized');
    }

    /** BYOK OAuth2Client — has client_id + secret + refresh_token. */
    private static createByokClient(tokens: OAuthTokens, clientId: string, clientSecret?: string): OAuth2Client {
        const client = new OAuth2Client(clientId, clientSecret ?? undefined, undefined);
        client.setCredentials({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || undefined,
            expiry_date: tokens.expires_at * 1000,
            scope: tokens.scopes?.join(' ') || undefined,
        });
        return client;
    }
}
