import { shell } from 'electron';
import type { Server } from 'http';
import { createAuthServer } from './auth-server.js';
import { DEFAULT_CALLBACK_PORT } from '@x/core/dist/auth/client-repo.js';
import * as oauthClient from '@x/core/dist/auth/oauth-client.js';
import type { Configuration } from '@x/core/dist/auth/oauth-client.js';
import { getProviderConfig, getAvailableProviders } from '@x/core/dist/auth/providers.js';
import container from '@x/core/dist/di/container.js';
import { IOAuthRepo, LEGACY_ACCOUNT_ID } from '@x/core/dist/auth/repo.js';
import { assertSafeAccountId } from '@x/core/dist/knowledge/mail_paths.js';
import { createHash } from 'crypto';
import { IClientRegistrationRepo } from '@x/core/dist/auth/client-repo.js';
import { triggerSync as triggerGmailSync } from '@x/core/dist/knowledge/sync_gmail.js';
import { triggerSync as triggerCalendarSync } from '@x/core/dist/knowledge/sync_calendar.js';
import { triggerSync as triggerFirefliesSync } from '@x/core/dist/knowledge/sync_fireflies.js';
import { emitOAuthEvent } from './ipc.js';

function buildRedirectUri(port: number): string {
  return `http://localhost:${port}/oauth/callback`;
}

/** Top-level openid-client messages that often wrap a more specific cause. */
const OPAQUE_OAUTH_TOP_MESSAGES = new Set(['invalid response encountered']);

function firstCauseMessage(error: unknown): string | undefined {
  if (error == null || typeof error !== 'object' || !('cause' in error)) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  if (typeof cause === 'string' && cause.trim()) {
    return cause;
  }
  return undefined;
}

/**
 * User-facing message for token-exchange failures. Prefer the first cause message when
 * the top-level message is opaque (common for openid-client) or when code is OAUTH_INVALID_RESPONSE.
 * The catch block below still logs the full cause chain for any error; this helper stays conservative.
 */
function getOAuthErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  const code = error != null && typeof error === 'object' && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
  const causeMsg = firstCauseMessage(error);
  if (code === 'OAUTH_INVALID_RESPONSE' && causeMsg) {
    return causeMsg;
  }
  if (causeMsg && OPAQUE_OAUTH_TOP_MESSAGES.has(msg.trim().toLowerCase())) {
    return causeMsg;
  }
  return msg;
}

// Store active OAuth flows (state -> { codeVerifier, provider, config })
const activeFlows = new Map<string, {
  codeVerifier: string;
  provider: string;
  config: Configuration;
}>();

// Module-level state for tracking the active OAuth flow
interface ActiveOAuthFlow {
  provider: string;
  state: string;
  server: Server;
  cleanupTimeout: NodeJS.Timeout;
}

let activeFlow: ActiveOAuthFlow | null = null;

/**
 * Cancel any active OAuth flow, cleaning up resources
 */
function cancelActiveFlow(reason: string = 'cancelled'): void {
  if (!activeFlow) {
    return;
  }

  console.log(`[OAuth] Cancelling active flow for ${activeFlow.provider}: ${reason}`);

  clearTimeout(activeFlow.cleanupTimeout);
  activeFlow.server.close();
  activeFlows.delete(activeFlow.state);

  // Only emit event for user-visible cancellations
  if (reason !== 'new_flow_started') {
    emitOAuthEvent({
      provider: activeFlow.provider,
      success: false,
      error: `OAuth flow ${reason}`
    });
  }

  activeFlow = null;
}

/**
 * Get OAuth repository from DI container
 */
function getOAuthRepo(): IOAuthRepo {
  return container.resolve<IOAuthRepo>('oauthRepo');
}

/**
 * Get client registration repository from DI container
 */
function getClientRegistrationRepo(): IClientRegistrationRepo {
  return container.resolve<IClientRegistrationRepo>('clientRegistrationRepo');
}

/**
 * Get or create OAuth configuration for a provider.
 * `redirectUri` is required for DCR providers — it is the actual callback URI
 * (including port) that was just bound, so the registration and auth URL stay in sync.
 */
async function getProviderConfiguration(
  provider: string,
  redirectUri: string = buildRedirectUri(DEFAULT_CALLBACK_PORT),
  credentialsOverride?: { clientId: string; clientSecret: string },
): Promise<Configuration> {
  const config = await getProviderConfig(provider);
  const resolveClientCredentials = async (): Promise<{ clientId: string; clientSecret?: string }> => {
    if (config.client.mode === 'static' && config.client.clientId) {
      // A build that ships its own registration still lets a user override it
      // with their own — useful for a workspace with its own consent screen.
      return {
        clientId: config.client.clientId,
        clientSecret: credentialsOverride?.clientSecret ?? config.client.clientSecret,
      };
    }
    if (credentialsOverride) {
      return { clientId: credentialsOverride.clientId, clientSecret: credentialsOverride.clientSecret };
    }
    const oauthRepo = getOAuthRepo();
    const connection = await oauthRepo.read(provider);
    if (connection.clientId) {
      return { clientId: connection.clientId, clientSecret: connection.clientSecret ?? undefined };
    }
    throw new Error(`${provider} client ID not configured. Please provide a client ID.`);
  };

  if (config.discovery.mode === 'issuer') {
    if (config.client.mode === 'static') {
      // Discover endpoints, use static client ID
      console.log(`[OAuth] ${provider}: Discovery from issuer with static client ID`);
      const { clientId, clientSecret } = await resolveClientCredentials();
      return await oauthClient.discoverConfiguration(
        config.discovery.issuer,
        clientId,
        clientSecret
      );
    } else {
      // DCR mode - check for existing registration or register new
      console.log(`[OAuth] ${provider}: Discovery from issuer with DCR`);
      const clientRepo = getClientRegistrationRepo();
      const existingRegistration = await clientRepo.getClientRegistration(provider);

      if (existingRegistration) {
        console.log(`[OAuth] ${provider}: Using existing DCR registration`);
        return await oauthClient.discoverConfiguration(
          config.discovery.issuer,
          existingRegistration.client_id
        );
      }

      // Register new client with the actual redirect URI (port already bound)
      const scopes = config.scopes || [];
      const { config: oauthConfig, registration } = await oauthClient.registerClient(
        config.discovery.issuer,
        [redirectUri],
        scopes
      );

      // Parse port from redirectUri (e.g. "http://localhost:8081/...") and save
      const boundPort = new URL(redirectUri).port
        ? parseInt(new URL(redirectUri).port, 10)
        : DEFAULT_CALLBACK_PORT;
      await clientRepo.saveClientRegistration(provider, registration, boundPort);
      console.log(`[OAuth] ${provider}: DCR registration saved (port ${boundPort})`);

      return oauthConfig;
    }
  } else {
    // Static endpoints mode
    if (config.client.mode !== 'static') {
      throw new Error('DCR requires discovery mode "issuer", not "static"');
    }

    console.log(`[OAuth] ${provider}: Using static endpoints (no discovery)`);
    const { clientId, clientSecret } = await resolveClientCredentials();
    return oauthClient.createStaticConfiguration(
      config.discovery.authorizationEndpoint,
      config.discovery.tokenEndpoint,
      clientId,
      config.discovery.revocationEndpoint,
      clientSecret
    );
  }
}

/**
 * Determine which port to start the OAuth callback server on for a DCR provider.
 *
 * If the provider has an existing registration, probes the port it was registered
 * on. If that port is still available, returns it so the existing client_id keeps
 * working. If it is blocked, clears the stale registration (forcing re-registration
 * on the next available port) and returns DEFAULT_CALLBACK_PORT as the scan base.
 *
 * Exported for unit testing.
 */
export async function resolveStartPort(
  provider: string,
  clientRepo: IClientRegistrationRepo,
): Promise<number> {
  const existingReg = await clientRepo.getClientRegistration(provider);
  if (!existingReg) return DEFAULT_CALLBACK_PORT;

  const registeredPort = await clientRepo.getRegisteredPort(provider);
  try {
    // Probe — fixed-port (no fallback) so we know whether the exact registered port is free
    const probe = await createAuthServer(registeredPort, () => { /* probe */ });
    probe.server.close();
    console.log(`[OAuth] ${provider}: registered port ${registeredPort} still available`);
    return registeredPort;
  } catch {
    console.log(`[OAuth] ${provider}: registered port ${registeredPort} blocked, clearing DCR registration`);
    await clientRepo.clearClientRegistration(provider);
    return DEFAULT_CALLBACK_PORT;
  }
}

/**
 * Initiate OAuth flow for a provider
 */
/**
 * Turn a grant's claims into a stable, filesystem-safe account id.
 *
 * Keyed on the provider's `sub` rather than the address: an address can be
 * renamed, and reusing it as a key would orphan the account's synced mail.
 * `sub` is opaque, so it is hashed when it contains anything that cannot be a
 * path segment. Providers that issue no id_token fall back to the legacy id,
 * which keeps single-account connects working exactly as before.
 */
function resolveAccountIdentity(identity: { sub?: string; email?: string }): { accountId: string; email: string | null } {
  const email = identity.email ?? null;
  const sub = identity.sub;
  if (!sub) return { accountId: LEGACY_ACCOUNT_ID, email };
  try {
    assertSafeAccountId(sub);
    return { accountId: sub, email };
  } catch {
    // Deterministic so the same subject always resolves to the same account.
    const digest = createHash('sha256').update(sub).digest('hex').slice(0, 32);
    return { accountId: digest, email };
  }
}

export async function connectProvider(provider: string, credentials?: { clientId: string; clientSecret: string }): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[OAuth] Starting connection flow for ${provider}...`);

    // Cancel any existing flow before starting a new one
    cancelActiveFlow('new_flow_started');

    const oauthRepo = getOAuthRepo();
    const providerConfig = await getProviderConfig(provider);

    if (provider === 'google') {
      if (!credentials?.clientId || !credentials?.clientSecret) {
        return { success: false, error: 'Google client ID and client secret are required to connect.' };
      }
    }

    // For static-client providers (Google BYOK) the redirect URI is pre-registered
    // at the OAuth provider console on a fixed port — we must not scan.
    // For DCR providers, resolveStartPort handles the re-registration trap.
    const isStaticClient = providerConfig.client.mode === 'static';
    const startPort = isStaticClient
      ? DEFAULT_CALLBACK_PORT
      : await resolveStartPort(provider, getClientRegistrationRepo());

    // --- Callback server ---
    // Declare `state` before the closure so the callback can close over its binding.
    // The variable is assigned below, before shell.openExternal, so it is always
    // set by the time any browser request arrives.
    let state = '';
    let callbackHandled = false;

    const { server, port: boundPort } = await createAuthServer(
      startPort,
      async (callbackUrl) => {
        // Guard against duplicate callbacks (browser may send multiple requests)
        if (callbackHandled) return;
        callbackHandled = true;
        const receivedState = callbackUrl.searchParams.get('state');
        if (receivedState == null || receivedState === '') {
          throw new Error(
            'OAuth callback missing state parameter. Complete sign-in in the browser or check the redirect URI.'
          );
        }
        if (receivedState !== state) {
          throw new Error('Invalid state parameter - possible CSRF attack');
        }

        const flow = activeFlows.get(state);
        if (!flow || flow.provider !== provider) {
          throw new Error('Invalid OAuth flow state');
        }

        try {
          // Use full callback URL (includes iss, scope, etc.) so openid-client validation succeeds
          console.log(`[OAuth] Exchanging authorization code for tokens (${provider})...`);
          const { tokens, identity: grantIdentity } = await oauthClient.exchangeCodeForTokens(
            flow.config,
            callbackUrl,
            flow.codeVerifier,
            state
          );

          // The grant identifies which mailbox was just authorized. Without
          // this every connect would overwrite the previous one; with it, a
          // second account lands beside the first.
          const identity = resolveAccountIdentity(grantIdentity);

          // Save tokens per account, credentials per provider. For Google, BYOK
          // is the only path that reaches this token exchange (dhow path
          // returns above before any local server runs); stamp mode: 'byok' so
          // a future refresh / reconnect can't get confused with a dhow entry.
          console.log(`[OAuth] Token exchange successful for ${provider} (account ${identity.accountId})`);
          if (credentials || provider === 'google') {
            await oauthRepo.upsert(provider, {
              ...(credentials ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret } : {}),
              ...(provider === 'google' ? { mode: 'byok' as const } : {}),
            });
          }
          await oauthRepo.upsertAccount(provider, identity.accountId, {
            tokens,
            email: identity.email,
            error: null,
          });

          // Trigger immediate sync for relevant providers
          if (provider === 'google') {
            triggerGmailSync();
            triggerCalendarSync();
          } else if (provider === 'fireflies-ai') {
            triggerFirefliesSync();
          }

          // Emit success event to renderer
          emitOAuthEvent({
            provider,
            success: true,
          });
        } catch (error) {
          console.error('OAuth token exchange failed:', error);
          // Log cause chain for debugging (e.g. OAUTH_INVALID_RESPONSE -> OperationProcessingError)
          let cause: unknown = error;
          while (cause != null && typeof cause === 'object' && 'cause' in cause) {
            cause = (cause as { cause?: unknown }).cause;
            if (cause != null) {
              console.error('[OAuth] Caused by:', cause);
            }
          }
          const errorMessage = getOAuthErrorMessage(error);
          emitOAuthEvent({ provider, success: false, error: errorMessage });
          throw error;
        } finally {
          // Clean up
          activeFlows.delete(state);
          if (activeFlow && activeFlow.state === state) {
            clearTimeout(activeFlow.cleanupTimeout);
            activeFlow.server.close();
            activeFlow = null;
          }
        }
      },
      // Static providers (Google BYOK) keep fixed-port behaviour to match the
      // pre-registered redirect URI at the provider's console. DCR providers
      // can fall back since we register the actual bound port below.
      { fallback: !isStaticClient },
    );

    // Server is bound. Any throw between here and `activeFlow = ...` would
    // leak the port — `cancelActiveFlow` only closes it once activeFlow is set.
    try {
      // TOCTOU guard: resolveStartPort probed the registered port and found it
      // free, but the port could have been grabbed between probe and real bind,
      // causing fallback to a different port. The cached client_id is registered
      // for the old port — clear it so getProviderConfiguration re-registers
      // with the actual bound port.
      if (!isStaticClient && boundPort !== startPort) {
        console.log(`[OAuth] ${provider}: bound port ${boundPort} differs from start port ${startPort}, clearing stale DCR registration`);
        await getClientRegistrationRepo().clearClientRegistration(provider);
      }

      const redirectUri = buildRedirectUri(boundPort);
      const config = await getProviderConfiguration(provider, redirectUri, credentials);

      const { verifier: codeVerifier, challenge: codeChallenge } = await oauthClient.generatePKCE();
      state = oauthClient.generateState();

      const scopes = providerConfig.scopes || [];
      activeFlows.set(state, { codeVerifier, provider, config });

      const authUrl = oauthClient.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        code_challenge: codeChallenge,
        state,
        // Google only returns a refresh_token when offline access is requested,
        // and only re-issues one when re-consent is forced. Without these, a
        // BYOK token expires after ~1h with no way to refresh (it goes stale and
        // every Google call — including the Picker — starts failing).
        ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : {}),
      });

      // Set timeout to clean up abandoned flows. Generous (10 min) because a
      // first-time connect can involve creating/locating OAuth credentials in
      // the Cloud Console mid-flow; a short window tears down the callback
      // server before the user finishes consent, silently dropping the token.
      const cleanupTimeout = setTimeout(() => {
        if (activeFlow?.state === state) {
          console.log(`[OAuth] Cleaning up abandoned OAuth flow for ${provider} (timeout)`);
          cancelActiveFlow('timed_out');
        }
      }, 10 * 60 * 1000);

      activeFlow = {
        provider,
        state,
        server,
        cleanupTimeout,
      };

      // Open in system browser (shares cookies/sessions with user's regular browser)
      shell.openExternal(authUrl.toString());

      return { success: true };
    } catch (setupError) {
      // Post-bind setup failed — close the server so the port is released and
      // a retry isn't blocked by our own zombie listener.
      server.close();
      if (state) {
        activeFlows.delete(state);
      }
      throw setupError;
    }
  } catch (error) {
    console.error('OAuth connection failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Disconnect a provider (clear tokens)
 */
export async function disconnectProvider(provider: string, accountId?: string): Promise<{ success: boolean }> {
  try {
    const oauthRepo = getOAuthRepo();

    if (accountId) {
      // Removing one mailbox leaves the others connected, and leaves the app
      // registration in place so the user need not re-enter it.
      await oauthRepo.deleteAccount(provider, accountId);
    } else {
      await oauthRepo.delete(provider);
    }

    // Notify renderer so sidebar, voice, and billing re-check state
    emitOAuthEvent({ provider, success: false });
    return { success: true };
  } catch (error) {
    console.error('OAuth disconnect failed:', error);
    return { success: false };
  }
}

/**
 * Startup migration for Google scope changes. When a connected Google grant was
 * issued before a scope was added (e.g. old installs on gmail.readonly that
 * never received gmail.modify), invalidate it so the user is prompted to
 * reconnect and re-grant with the current scopes. The currently-requested
 * scopes in the provider config are the source of truth: a grant missing any
 * of them is treated as stale.
 *
 * We revoke + clear the stale token but DELIBERATELY keep the provider entry
 * with an `error` set rather than calling disconnectProvider (which deletes the
 * whole entry). The renderer's reconnect prompts — the sidebar "Reconnect your
 * accounts" alert and the connectors "Reconnect" row — key off this `error`
 * field, not off the connected flag. A fully deleted entry has no error and is
 * indistinguishable from "never connected", so no prompt would ever appear.
 *
 * Tokens with no recorded scopes (very old installs that never persisted them)
 * are also treated as stale. Safe to call on every startup — it's a no-op once
 * the grant covers all current scopes, and once invalidated the early return on
 * the missing token keeps it from re-running until the user reconnects.
 */
export async function disconnectGoogleIfScopesStale(): Promise<void> {
  try {
    const oauthRepo = getOAuthRepo();
    const connection = await oauthRepo.read('google');

    const providerConfig = await getProviderConfig('google');
    const requiredScopes = providerConfig.scopes ?? [];
    if (requiredScopes.length === 0) {
      return;
    }

    let invalidatedAny = false;
    // Each account carries its own grant, so scopes are checked per account:
    // an older mailbox can be stale while a freshly connected one is current.
    for (const [accountId, account] of Object.entries(connection.accounts)) {
      // Not connected (or already invalidated) — nothing to migrate.
      if (!account.tokens) continue;

      const granted = new Set(account.tokens.scopes ?? []);
      const missingScopes = requiredScopes.filter((scope) => !granted.has(scope));
      if (missingScopes.length === 0) continue;

      console.log(
        `[OAuth] Google grant for ${accountId} is missing current scopes [${missingScopes.join(', ')}]; ` +
        'invalidating it so the user is prompted to reconnect with the new scopes.'
      );

      // Best-effort revoke at Google for dhow-mode grants (mirrors disconnectProvider).
      if (connection.mode === 'dhow' && account.tokens.access_token) {
        try {
          const revokeUrl = `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(account.tokens.access_token)}`;
          const res = await fetch(revokeUrl, { method: 'POST', signal: AbortSignal.timeout(5000) });
          if (!res.ok) {
            console.warn(`[OAuth] Google revoke returned ${res.status}; continuing with local invalidation`);
          }
        } catch (error) {
          console.warn('[OAuth] Google revoke failed; continuing with local invalidation:', error);
        }
      }

      // Drop the stale token but keep the account with an error so the reconnect
      // prompt fires (see the note above).
      await oauthRepo.upsertAccount('google', accountId, {
        tokens: null,
        error: 'Google permissions changed. Please reconnect to continue.',
      });
      invalidatedAny = true;
    }

    // Nudge any already-open window to re-read state. The renderer's initial
    // mount also re-reads, so the prompt shows even if no window is up yet.
    if (invalidatedAny) emitOAuthEvent({ provider: 'google', success: false });
  } catch (error) {
    console.error('[OAuth] Google scope migration check failed:', error);
  }
}

/**
 * Get access token for a provider (internal use only)
 * Refreshes token if expired
 */
export async function getAccessToken(provider: string, accountId?: string): Promise<string | null> {
  try {
    const oauthRepo = getOAuthRepo();

    const resolved = accountId ?? await oauthRepo.getPrimaryAccountId(provider);
    if (!resolved) {
      return null;
    }
    let { tokens } = await oauthRepo.readAccount(provider, resolved);
    if (!tokens) {
      return null;
    }

    // Check if token needs refresh
    if (oauthClient.isTokenExpired(tokens)) {
      if (!tokens.refresh_token) {
        // No refresh token, need to reconnect
        await oauthRepo.upsertAccount(provider, resolved, { error: 'Missing refresh token. Please reconnect.' });
        return null;
      }

      try {
        // Get configuration for refresh
        const config = await getProviderConfiguration(provider);

        // Refresh token, preserving existing scopes
        const existingScopes = tokens.scopes;
        const refreshedTokens = await oauthClient.refreshTokens(config, tokens.refresh_token, existingScopes);
        await oauthRepo.upsertAccount(provider, resolved, { tokens: refreshedTokens });
        tokens = refreshedTokens;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Token refresh failed';
        await oauthRepo.upsertAccount(provider, resolved, { error: message });
        console.error('Token refresh failed:', error);
        return null;
      }
    }

    return tokens.access_token;
  } catch (error) {
    console.error('Get access token failed:', error);
    return null;
  }
}

/**
 * Get list of available providers
 */
export function listProviders(): { providers: string[] } {
  return { providers: getAvailableProviders() };
}
