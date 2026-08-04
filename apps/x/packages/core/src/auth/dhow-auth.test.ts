import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Configuration } from './oauth-client.js';

// Dynamic imports are required here, not stylistic: WorkDir is resolved at
// module-import time (config/config.ts), so it must be set before the
// modules under test load. Same pattern as chatgpt-auth.test.ts.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-dhow-auth-test-'));
process.env.DHOW_WORKDIR = tmpWorkDir;

const oauthClient = await import('./oauth-client.js');
const dhowApi = await import('../config/dhow-api.js');
const { getDhowAccessToken, getDhowStatus, DhowAuthRequiredError } = await import('./dhow-auth.js');

const AUTH_FILE = path.join(tmpWorkDir, 'config', 'oauth.json');
const CLIENT_REG_FILE = path.join(tmpWorkDir, 'config', 'oauth-clients.json');
const NOW = Math.floor(Date.now() / 1000);

/**
 * Promise.withResolvers is ES2024; this package targets ES2022, so the global
 * exists at runtime but is not declared. Hand-rolled equivalent — no timers,
 * so the concurrency test stays deterministic instead of racing a sleep.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

const freshTokens = (accessToken: string, expiresAt: number) => ({
    access_token: accessToken,
    refresh_token: 'rt-next',
    expires_at: expiresAt,
    token_type: 'Bearer' as const,
    scopes: ['openid', 'offline_access'],
});

function writeGrant(opts: { expiresAt: number; refresh?: string | null }): void {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify({
        version: 3,
        providers: {
            dhow: {
                primaryAccountId: 'u1',
                accounts: {
                    u1: {
                        tokens: {
                            access_token: 'stale-access',
                            refresh_token: opts.refresh === undefined ? 'rt-1' : opts.refresh,
                            expires_at: opts.expiresAt,
                            token_type: 'Bearer',
                            scopes: ['openid', 'offline_access'],
                        },
                        email: 'saj@dhow.io',
                    },
                },
            },
        },
    }));
}

function writeSignedOut(): void {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ version: 3, providers: {} }));
}

/**
 * Seeds a DCR client registration for "dhow" — the same shape
 * FSClientRegistrationRepo writes after a real registration. Default state
 * for every test; the "no registration" test removes the file instead.
 */
function writeClientRegistration(): void {
    fs.mkdirSync(path.dirname(CLIENT_REG_FILE), { recursive: true });
    fs.writeFileSync(CLIENT_REG_FILE, JSON.stringify({
        dhow: { client_id: 'dcr-client-id', _registeredPort: 8080 },
    }));
}

beforeEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(AUTH_FILE, { force: true });
    fs.rmSync(CLIENT_REG_FILE, { force: true });
    writeClientRegistration();
    // performRefresh resolves the OIDC configuration before exchanging the
    // token; without this it would reach for a real .well-known document and
    // every refresh assertion would fail as "fetch failed".
    vi.spyOn(oauthClient, 'discoverConfiguration').mockResolvedValue({} as Configuration);
    // getProviderConfig('dhow') resolves its issuer from the runtime
    // bootstrap (GET ${API_URL}/v1/config); without this every test would
    // need a live network call just to build the provider config.
    vi.spyOn(dhowApi, 'getDhowApiConfig').mockResolvedValue({
        appUrl: 'https://dhow.example.test',
        supabaseUrl: 'https://auth.example.test',
    });
});
afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('getDhowStatus', () => {
    it('reports signed out when there is no grant, without throwing', async () => {
        writeSignedOut();
        expect(await getDhowStatus()).toEqual({ signedIn: false });
    });

    it('reports the signed-in account email', async () => {
        writeGrant({ expiresAt: NOW + 3600 });
        expect(await getDhowStatus()).toEqual({ signedIn: true, email: 'saj@dhow.io' });
    });
});

describe('getDhowAccessToken', () => {
    it('returns the current token untouched while it is still valid', async () => {
        writeGrant({ expiresAt: NOW + 3600 });
        const refresh = vi.spyOn(oauthClient, 'refreshTokens');
        expect(await getDhowAccessToken()).toBe('stale-access');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('throws DhowAuthRequiredError when signed out', async () => {
        writeSignedOut();
        await expect(getDhowAccessToken()).rejects.toBeInstanceOf(DhowAuthRequiredError);
    });

    it('demands sign-in when no client has been dynamically registered', async () => {
        writeGrant({ expiresAt: NOW - 10 });
        fs.rmSync(CLIENT_REG_FILE, { force: true });
        await expect(getDhowAccessToken()).rejects.toBeInstanceOf(DhowAuthRequiredError);
    });

    it('an expired grant with no refresh token records why, then demands re-consent', async () => {
        writeGrant({ expiresAt: NOW - 10, refresh: null });
        await expect(getDhowAccessToken()).rejects.toBeInstanceOf(DhowAuthRequiredError);
        const stored = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
        expect(stored.providers.dhow.accounts.u1.error).toMatch(/cannot be refreshed/i);
    });

    // GoTrue rotates refresh tokens by default: a refresh consumes the
    // token it presents. Two callers racing an expired session must not
    // both refresh — the second would replay a spent token, which GoTrue
    // treats as reuse and can revoke the whole grant. Guarding this is the
    // difference between one slow request and a silent sign-out.
    it('collapses concurrent refreshes into a single token exchange', async () => {
        writeGrant({ expiresAt: NOW - 10 });
        const entered = deferred<void>();
        const release = deferred<void>();
        const refresh = vi.spyOn(oauthClient, 'refreshTokens').mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return freshTokens('fresh-access', NOW + 3600);
        });

        const calls = [getDhowAccessToken(), getDhowAccessToken(), getDhowAccessToken()];
        // Deterministic barrier: a refresh is provably in flight, and it stays
        // in flight until we say so — no sleep, no tuned delay.
        await entered.promise;
        release.resolve();

        expect(await Promise.all(calls)).toEqual(['fresh-access', 'fresh-access', 'fresh-access']);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('allows a later refresh once the in-flight one has settled', async () => {
        writeGrant({ expiresAt: NOW - 10 });
        // Still expired after refreshing, so a second call must refresh again —
        // proving the single-flight slot was released rather than latched.
        const refresh = vi.spyOn(oauthClient, 'refreshTokens')
            .mockResolvedValue(freshTokens('fresh-access', NOW - 5));

        await getDhowAccessToken();
        await getDhowAccessToken();
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('a failed refresh records the reason and does not wedge later attempts', async () => {
        writeGrant({ expiresAt: NOW - 10 });
        const refresh = vi.spyOn(oauthClient, 'refreshTokens')
            .mockRejectedValueOnce(new Error('invalid_grant'));

        await expect(getDhowAccessToken()).rejects.toBeInstanceOf(DhowAuthRequiredError);
        const stored = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
        expect(stored.providers.dhow.accounts.u1.error).toMatch(/invalid_grant/);

        // The single-flight slot must have been released, not left holding a
        // rejected promise that every later caller would inherit.
        refresh.mockResolvedValueOnce(freshTokens('recovered', NOW + 3600));
        expect(await getDhowAccessToken()).toBe('recovered');
    });
});
