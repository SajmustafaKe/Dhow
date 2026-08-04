import container from '../di/container.js';
import { IOAuthRepo, LEGACY_ACCOUNT_ID } from './repo.js';
import { IClientRegistrationRepo } from './client-repo.js';
import { getProviderConfig } from './providers.js';
import * as oauthClient from './oauth-client.js';
import type { Configuration } from './oauth-client.js';

/**
 * Auth state for the Dhow account (provider "dhow" in oauth.json).
 *
 * Deliberately thinner than auth/chatgpt-auth.ts: ChatGPT needs a bespoke
 * store because its flow is non-standard, whereas the Dhow account is an
 * ordinary OIDC grant that connectProvider already writes through the shared
 * OAuth repo. So this file owns no storage and no configuration cache — it
 * reads the same records every other provider uses and only adds
 * refresh-on-read, mirroring knowledge/fireflies-client-factory.ts.
 *
 * The account is single-identity: one signed-in user per install, riding the
 * provider's primary account and falling back to the legacy id the first
 * time — the same convention Fireflies uses.
 */

const PROVIDER_NAME = 'dhow';

export class DhowAuthRequiredError extends Error {
    constructor() {
        super('Not signed in to Dhow. Sign in from Settings to use Dhow models.');
        this.name = 'DhowAuthRequiredError';
    }
}

/**
 * OIDC configuration used to refresh. Not cached here on purpose:
 * discoverConfiguration already memoizes per issuer+clientId, and a second
 * cache would only add a way for the two to disagree.
 */
async function resolveRefreshConfiguration(): Promise<Configuration> {
    const providerConfig = await getProviderConfig(PROVIDER_NAME);
    // The dhow entry is always issuer+dcr (see auth/providers.ts); these
    // guards exist so a future edit that changes that fails loudly here
    // rather than refreshing against the wrong endpoints.
    if (providerConfig.discovery.mode !== 'issuer' || providerConfig.client.mode !== 'dcr') {
        throw new Error('Dhow provider must use issuer discovery with a dynamically registered client.');
    }

    const clientRepo = container.resolve<IClientRegistrationRepo>('clientRegistrationRepo');
    const registration = await clientRepo.getClientRegistration(PROVIDER_NAME);
    if (!registration) {
        throw new DhowAuthRequiredError();
    }

    return oauthClient.discoverConfiguration(
        providerConfig.discovery.issuer,
        registration.client_id,
    );
}

/**
 * Whether an account is connected. Shaped like getChatGPTStatus so the model
 * catalog can branch on both the same way. Never throws: a status check must
 * not be able to break the provider list.
 */
export async function getDhowStatus(): Promise<{ signedIn: boolean; email?: string }> {
    try {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const id = (await oauthRepo.getPrimaryAccountId(PROVIDER_NAME)) ?? LEGACY_ACCOUNT_ID;
        const account = await oauthRepo.readAccount(PROVIDER_NAME, id);
        if (!account.tokens) return { signedIn: false };
        return {
            signedIn: true,
            ...(account.email ? { email: account.email } : {}),
        };
    } catch {
        return { signedIn: false };
    }
}

/**
 * In-flight refresh, shared by concurrent callers.
 *
 * GoTrue rotates refresh tokens by default, so a refresh consumes the token
 * it presents. Two model calls racing an expired session would otherwise
 * both refresh: the second presents an already-rotated token, GoTrue treats
 * that as replay, and the whole grant can be revoked — signing the user
 * out. Rowboat guarded the same way (historical
 * packages/core/src/auth/tokens.ts, `refreshInFlight`), and rotation makes
 * it mandatory here rather than merely wasteful.
 */
let refreshInFlight: Promise<string> | null = null;

async function performRefresh(id: string, refreshToken: string, scopes?: string[]): Promise<string> {
    const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
    try {
        const config = await resolveRefreshConfiguration();
        const refreshed = await oauthClient.refreshTokens(config, refreshToken, scopes);
        await oauthRepo.upsertAccount(PROVIDER_NAME, id, { tokens: refreshed, error: null });
        return refreshed.access_token;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to refresh the Dhow session';
        await oauthRepo.upsertAccount(PROVIDER_NAME, id, { error: message });
        throw new DhowAuthRequiredError();
    }
}

/**
 * A valid access token, refreshing first when the current one has expired.
 *
 * Throws DhowAuthRequiredError rather than returning null when there is no
 * usable grant, so a signed-out state surfaces as "sign in" at the call site
 * instead of an opaque 401 from the gateway.
 */
export async function getDhowAccessToken(): Promise<string> {
    const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
    const id = (await oauthRepo.getPrimaryAccountId(PROVIDER_NAME)) ?? LEGACY_ACCOUNT_ID;
    const tokens = (await oauthRepo.readAccount(PROVIDER_NAME, id)).tokens;

    if (!tokens) {
        throw new DhowAuthRequiredError();
    }
    if (!oauthClient.isTokenExpired(tokens)) {
        return tokens.access_token;
    }
    if (!tokens.refresh_token) {
        // No refresh token means the grant cannot be renewed — the only
        // fix is fresh consent. Record why, so the UI can say that instead
        // of showing a bare expiry.
        await oauthRepo.upsertAccount(PROVIDER_NAME, id, {
            error: 'Dhow session expired and cannot be refreshed. Sign in again.',
        });
        throw new DhowAuthRequiredError();
    }

    if (!refreshInFlight) {
        refreshInFlight = performRefresh(id, tokens.refresh_token, tokens.scopes)
            .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
}
