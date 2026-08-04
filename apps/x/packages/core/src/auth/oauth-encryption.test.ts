import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Dynamic import: WorkDir is resolved at config.ts import time.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-oauth-enc-'));
fs.mkdirSync(path.join(tmpWorkDir, 'config'), { recursive: true });
process.env.DHOW_WORKDIR = tmpWorkDir;

const { setSecretCipher } = await import('./secret-cipher.js');
const { FSOAuthRepo } = await import('./repo.js');

const CONFIG = path.join(tmpWorkDir, 'config', 'oauth.json');

// Stand-in for Electron safeStorage. Reversible and obviously not real crypto —
// the assertions are about *whether* values are transformed at the file
// boundary, not about cipher strength.
const reversible = {
    isAvailable: () => true,
    encrypt: (plain: string) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (b64: string) => Buffer.from(b64, 'base64').toString('utf8'),
};

const grant = (refresh: string) => ({
    tokens: {
        access_token: 'at-secret',
        refresh_token: refresh,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer' as const,
        scopes: ['openid'],
    },
    email: 'saj@dhow.io',
});

beforeEach(() => {
    fs.rmSync(CONFIG, { force: true });
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('oauth.json secrets at rest', () => {
    it('writes tokens as ciphertext and reads them back as plaintext', async () => {
        setSecretCipher(reversible);
        const repo = new FSOAuthRepo();
        await repo.upsertAccount('google', 'u1', grant('rt-secret'));

        // On disk: no readable secret anywhere.
        const onDisk = await fsp.readFile(CONFIG, 'utf8');
        expect(onDisk).not.toContain('rt-secret');
        expect(onDisk).not.toContain('at-secret');
        expect(onDisk).toContain('enc:v1:');
        // The non-secret label is deliberately left readable.
        expect(onDisk).toContain('saj@dhow.io');

        // Through the repo: callers still see plaintext.
        const account = await repo.readAccount('google', 'u1');
        expect(account.tokens?.refresh_token).toBe('rt-secret');
        expect(account.tokens?.access_token).toBe('at-secret');
    });

    it('restricts the file to the owner', async () => {
        setSecretCipher(reversible);
        await new FSOAuthRepo().upsertAccount('google', 'u1', grant('rt-secret'));
        const mode = (await fsp.stat(CONFIG)).mode & 0o777;
        expect(mode & 0o077).toBe(0); // no group or other access
    });

    // An upgrade must not lock anyone out of their own mailbox.
    it('still reads a pre-existing plaintext file, then upgrades it on write', async () => {
        fs.writeFileSync(CONFIG, JSON.stringify({
            version: 3,
            providers: {
                google: { primaryAccountId: 'u1', accounts: { u1: grant('legacy-plaintext') } },
            },
        }));
        setSecretCipher(reversible);
        const repo = new FSOAuthRepo();

        expect((await repo.readAccount('google', 'u1')).tokens?.refresh_token).toBe('legacy-plaintext');

        await repo.upsertAccount('google', 'u1', grant('legacy-plaintext'));
        expect(await fsp.readFile(CONFIG, 'utf8')).not.toContain('legacy-plaintext');
        expect((await repo.readAccount('google', 'u1')).tokens?.refresh_token).toBe('legacy-plaintext');
    });

    // Refusing to save a credential because a Linux box has no libsecret would
    // be worse than storing it the way every previous version already did.
    it('degrades to plaintext when no keychain is available', async () => {
        setSecretCipher({ isAvailable: () => false, encrypt: () => { throw new Error('nope'); }, decrypt: () => { throw new Error('nope'); } });
        const repo = new FSOAuthRepo();
        await repo.upsertAccount('google', 'u1', grant('rt-secret'));

        expect(await fsp.readFile(CONFIG, 'utf8')).toContain('rt-secret');
        expect((await repo.readAccount('google', 'u1')).tokens?.refresh_token).toBe('rt-secret');
    });
});
