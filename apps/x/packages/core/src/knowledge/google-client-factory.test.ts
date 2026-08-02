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
  getClientFacingConfig: ReturnType<typeof vi.fn>;
}

let refreshSpy: ReturnType<typeof vi.fn>;
let releaseRefresh: () => void;
let mockOAuthRepo: MockOAuthRepo;
let storedTokens: OAuthTokens;

const connection = (tokens: OAuthTokens) => ({
  tokens,
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret',
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

  mockOAuthRepo = {
    read: vi.fn(async () => connection(storedTokens)),
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
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
    const errorUpserts = mockOAuthRepo.upsert.mock.calls.filter(
      ([, conn]) => (conn as { error?: string | null }).error,
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
    mockOAuthRepo.read = vi.fn(async () => connection(storedTokens));

    const { GoogleClientFactory } = await import('./google-client-factory.js');
    GoogleClientFactory.clearCache();

    const a = await GoogleClientFactory.getClient();
    const b = await GoogleClientFactory.getClient();

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(a).toBe(b);
  });
});
