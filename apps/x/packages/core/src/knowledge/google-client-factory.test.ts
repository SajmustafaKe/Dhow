import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthTokens } from '../auth/types.js';

/**
 * Regression for the cold-start race that left a stuck `error` field in
 * oauth.json: Gmail + Calendar both call getClient() in the same tick, the
 * dedup singleton's check-and-assign were separated by an `await`, two
 * parallel refreshes go out, and the failure path from the loser could land
 * last and stick "Needs reconnect" in the UI even though tokens were valid.
 */

interface MockOAuthRepo {
  read: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  readAccount: ReturnType<typeof vi.fn>;
  upsertAccount: ReturnType<typeof vi.fn>;
  deleteAccount: ReturnType<typeof vi.fn>;
  listAccounts: ReturnType<typeof vi.fn>;
  getPrimaryAccountId: ReturnType<typeof vi.fn>;
  setPrimaryAccountId: ReturnType<typeof vi.fn>;
  getClientFacingConfig: ReturnType<typeof vi.fn>;
}

/** Tokens are per-account now; the app registration stays provider-level. */
const ACCOUNT_A = 'sub-a';
const ACCOUNT_B = 'sub-b';

let refreshSpy: ReturnType<typeof vi.fn>;
let releaseRefresh: () => void;
let mockOAuthRepo: MockOAuthRepo;
let storedTokens: OAuthTokens;
let accountTokens: Record<string, OAuthTokens>;

const providerRecord = (accounts: Record<string, OAuthTokens>) => ({
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret',
  accounts: Object.fromEntries(Object.entries(accounts).map(([id, tokens]) => [id, { tokens }])),
  primaryAccountId: Object.keys(accounts)[0] ?? null,
});

beforeEach(() => {
  vi.resetModules();

  // Expired 1 minute ago — forces the refresh path through getClient.
  storedTokens = {
    access_token: 'old-access',
    refresh_token: 'rt',
    expires_at: Math.floor(Date.now() / 1000) - 60,
    token_type: 'Bearer',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  };

  accountTokens = { [ACCOUNT_A]: storedTokens };

  mockOAuthRepo = {
    read: vi.fn(async () => providerRecord(accountTokens)),
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    readAccount: vi.fn(async (_p: string, id: string) => ({ tokens: accountTokens[id] })),
    upsertAccount: vi.fn(async () => undefined),
    deleteAccount: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => Object.keys(accountTokens)),
    getPrimaryAccountId: vi.fn(async () => Object.keys(accountTokens)[0] ?? null),
    setPrimaryAccountId: vi.fn(async () => undefined),
    getClientFacingConfig: vi.fn(async () => ({})),
  };

  vi.doMock('../di/container.js', () => ({
    default: {
      resolve: (key: string) => {
        if (key === 'oauthRepo') return mockOAuthRepo;
        throw new Error(`unexpected DI resolve in test: ${key}`);
      },
    },
  }));

  vi.doMock('../auth/providers.js', () => ({
    getProviderConfig: vi.fn(async () => ({
      discovery: { mode: 'issuer', issuer: 'https://accounts.google.com' },
      client: { mode: 'static' },
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    })),
  }));

  // The refresh is held open until the test releases it, so both concurrent
  // callers are guaranteed to be in flight simultaneously. A real delay would
  // make the overlap a timing guess; this makes it a certainty.
  const gate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  refreshSpy = vi.fn(async (_config: unknown, _rt: string, scopes?: string[]) => {
    await gate;
    return {
      access_token: 'new-access',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'Bearer' as const,
      scopes,
    };
  });

  vi.doMock('../auth/oauth-client.js', async () => {
    const actual = await vi.importActual<typeof import('../auth/oauth-client.js')>(
      '../auth/oauth-client.js',
    );
    return {
      ...actual,
      discoverConfiguration: vi.fn(async () => ({ mocked: true })),
      refreshTokens: refreshSpy,
    };
  });
});

afterEach(() => {
  vi.doUnmock('../di/container.js');
  vi.doUnmock('../auth/providers.js');
  vi.doUnmock('../auth/oauth-client.js');
  vi.resetModules();
});

describe('GoogleClientFactory.getClient', () => {
  it('coalesces concurrent callers into a single refresh', async () => {
    const { GoogleClientFactory } = await import('./google-client-factory.js');
    GoogleClientFactory.clearCache();

    // Same tick — this is the exact pattern that sync_gmail.init() and
    // sync_calendar.init() produce on cold start. Both calls are launched
    // before the refresh is allowed to settle.
    const pending = Promise.all([
      GoogleClientFactory.getClient(),
      GoogleClientFactory.getClient(),
    ]);
    releaseRefresh();
    const [a, b] = await pending;

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(a).not.toBeNull();
    expect(a).toBe(b);

    // And no failure-path upsert fires, so oauth.json doesn't get a stuck error.
    const errorUpserts = mockOAuthRepo.upsertAccount.mock.calls.filter(
      ([, , conn]) => (conn as { error?: string | null }).error,
    );
    expect(errorUpserts).toHaveLength(0);
  });

  it('returns cached client when tokens are not expired', async () => {
    // Tokens valid for another hour — no refresh should fire.
    storedTokens = {
      access_token: 'fresh-access',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'Bearer',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    };
    accountTokens = { [ACCOUNT_A]: storedTokens };

    const { GoogleClientFactory } = await import('./google-client-factory.js');
    GoogleClientFactory.clearCache();

    const a = await GoogleClientFactory.getClient();
    const b = await GoogleClientFactory.getClient();

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(a).toBe(b);
  });
});

describe('GoogleClientFactory multi-account', () => {
  it('gives each account its own client rather than sharing one', async () => {
    const fresh = (access: string): OAuthTokens => ({
      access_token: access,
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'Bearer',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    accountTokens = { [ACCOUNT_A]: fresh('access-a'), [ACCOUNT_B]: fresh('access-b') };

    const { GoogleClientFactory } = await import('./google-client-factory.js');
    GoogleClientFactory.clearCache();

    const a = await GoogleClientFactory.getClient(ACCOUNT_A);
    const b = await GoogleClientFactory.getClient(ACCOUNT_B);

    // Sharing a client across accounts would send one mailbox's requests
    // with the other's credentials.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    // Each still caches independently.
    expect(await GoogleClientFactory.getClient(ACCOUNT_A)).toBe(a);
  });

  it('resolves the primary account when none is named', async () => {
    // Fresh tokens: this test is about which account is chosen, not refresh,
    // and the shared beforeEach seeds an expired grant behind a gated refresh.
    accountTokens = {
      [ACCOUNT_A]: {
        access_token: 'access-a',
        refresh_token: 'rt',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      },
    };

    const { GoogleClientFactory } = await import('./google-client-factory.js');
    GoogleClientFactory.clearCache();

    // Calendar, Docs and agent notes call getClient() with no account.
    await GoogleClientFactory.getClient();

    expect(mockOAuthRepo.getPrimaryAccountId).toHaveBeenCalled();
    expect(mockOAuthRepo.readAccount).toHaveBeenCalledWith('google', ACCOUNT_A);
  });

  it('evicts only the named account from the cache', async () => {
    const fresh = (access: string): OAuthTokens => ({
      access_token: access,
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'Bearer',
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    });
    accountTokens = { [ACCOUNT_A]: fresh('access-a'), [ACCOUNT_B]: fresh('access-b') };

    const { GoogleClientFactory } = await import('./google-client-factory.js');
    GoogleClientFactory.clearCache();

    const a1 = await GoogleClientFactory.getClient(ACCOUNT_A);
    const b1 = await GoogleClientFactory.getClient(ACCOUNT_B);
    // A revoked grant on one mailbox must not disconnect the others.
    GoogleClientFactory.clearCache(ACCOUNT_A);

    expect(await GoogleClientFactory.getClient(ACCOUNT_A)).not.toBe(a1);
    expect(await GoogleClientFactory.getClient(ACCOUNT_B)).toBe(b1);
  });
});
