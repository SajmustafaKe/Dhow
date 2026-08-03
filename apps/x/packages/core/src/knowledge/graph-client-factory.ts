import container from '../di/container.js';
import { IOAuthRepo } from '../auth/repo.js';
import { getProviderConfig } from '../auth/providers.js';
import * as oauthClient from '../auth/oauth-client.js';
import type { Configuration } from '../auth/oauth-client.js';
import { OAuthTokens } from '../auth/types.js';

/**
 * Access tokens for Microsoft Graph, per account.
 *
 * Mirrors GoogleClientFactory's structure — shared OIDC configuration and app
 * registration, per-account tokens and refresh coalescing — because the two
 * have the same shape of problem: one app registration authorizing several
 * mailboxes, each with an independently revocable grant.
 *
 * Returns a bearer token rather than an SDK client. Graph's REST surface is
 * small enough here (delta, messages, attachments) that `fetch` is clearer
 * than a client library, and it keeps a heavy dependency out of the bundle.
 */
export class GraphClientFactory {
    private static readonly PROVIDER_NAME = 'microsoft';

    private static shared: {
        config: Configuration | null;
        clientId: string | null;
        clientSecret: string | null;
    } = { config: null, clientId: null, clientSecret: null };

    private static accounts = new Map<string, { token: string; expiresAt: number }>();

    /** Per-account, so two mailboxes refreshing at once neither block nor clobber. */
    private static inFlight = new Map<string, Promise<string | null>>();

    static async listAccountIds(): Promise<string[]> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        return oauthRepo.listAccounts(this.PROVIDER_NAME);
    }

    private static async resolveAccountId(accountId?: string): Promise<string | null> {
        if (accountId) return accountId;
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        return oauthRepo.getPrimaryAccountId(this.PROVIDER_NAME);
    }

    private static async initializeConfigCache(): Promise<void> {
        if (this.shared.config) return;
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const connection = await oauthRepo.read(this.PROVIDER_NAME);
        if (!connection.clientId) {
            throw new Error('Microsoft client ID missing. Please reconnect.');
        }
        const providerConfig = await getProviderConfig(this.PROVIDER_NAME);
        if (providerConfig.discovery.mode !== 'issuer') {
            throw new Error('Microsoft provider must use issuer discovery.');
        }
        this.shared.clientId = connection.clientId;
        this.shared.clientSecret = connection.clientSecret ?? null;
        this.shared.config = await oauthClient.discoverConfiguration(
            providerConfig.discovery.issuer,
            connection.clientId,
            connection.clientSecret ?? undefined,
        );
    }

    /**
     * A valid access token for one mailbox, refreshing when it is close to
     * expiry. Omit `accountId` for the primary account.
     */
    static async getAccessToken(accountId?: string): Promise<string | null> {
        const resolved = await this.resolveAccountId(accountId);
        if (!resolved) return null;

        const cached = this.accounts.get(resolved);
        // 60s of headroom so a long request cannot straddle expiry.
        if (cached && cached.expiresAt - 60 > Math.floor(Date.now() / 1000)) return cached.token;

        const existing = this.inFlight.get(resolved);
        if (existing) return existing;

        const pending = this.refresh(resolved).finally(() => this.inFlight.delete(resolved));
        this.inFlight.set(resolved, pending);
        return pending;
    }

    private static async refresh(accountId: string): Promise<string | null> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const account = await oauthRepo.readAccount(this.PROVIDER_NAME, accountId);
        const tokens = account.tokens ?? null;
        if (!tokens) {
            this.accounts.delete(accountId);
            return null;
        }

        if (!oauthClient.isTokenExpired(tokens)) {
            this.accounts.set(accountId, { token: tokens.access_token, expiresAt: tokens.expires_at });
            return tokens.access_token;
        }

        if (!tokens.refresh_token) {
            await oauthRepo.upsertAccount(this.PROVIDER_NAME, accountId, {
                error: 'Missing refresh token. Please reconnect.',
            });
            this.accounts.delete(accountId);
            return null;
        }

        try {
            await this.initializeConfigCache();
            if (!this.shared.config) return null;
            const refreshed: OAuthTokens = await oauthClient.refreshTokens(
                this.shared.config,
                tokens.refresh_token,
                tokens.scopes,
            );
            await oauthRepo.upsertAccount(this.PROVIDER_NAME, accountId, { tokens: refreshed, error: null });
            this.accounts.set(accountId, { token: refreshed.access_token, expiresAt: refreshed.expires_at });
            return refreshed.access_token;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to refresh Microsoft token';
            await oauthRepo.upsertAccount(this.PROVIDER_NAME, accountId, { error: message });
            console.error(`[Graph] Refresh failed for ${accountId}:`, error);
            // Scoped to this account: a revoked grant on one mailbox must not
            // evict the others or the shared discovery.
            this.accounts.delete(accountId);
            return null;
        }
    }

    static clearCache(accountId?: string): void {
        if (accountId) {
            this.accounts.delete(accountId);
            return;
        }
        this.accounts.clear();
        this.shared = { config: null, clientId: null, clientSecret: null };
    }
}

export interface GraphRequestOptions {
    method?: string;
    /** Absolute Graph URL, or a path relative to the v1.0 root. */
    url: string;
    accountId: string;
    body?: unknown;
    /** Extra request headers, e.g. `Prefer` to pin the response time zone. */
    headers?: Record<string, string>;
}

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

/** One authorized Graph call, with the error body surfaced rather than swallowed. */
export async function graphRequest<T>({ method = 'GET', url, accountId, body, headers }: GraphRequestOptions): Promise<T> {
    const token = await GraphClientFactory.getAccessToken(accountId);
    if (!token) throw new Error(`Microsoft account ${accountId} is not connected.`);

    const target = url.startsWith('http') ? url : `${GRAPH_ROOT}${url}`;
    const res = await fetch(target, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
        // Graph reports the useful part in the body; the status alone is
        // rarely enough to tell a scope problem from a throttle.
        const detail = await res.text().catch(() => '');
        throw new Error(`Graph ${method} ${target} failed: ${res.status} ${detail.slice(0, 400)}`);
    }
    return (await res.json()) as T;
}
