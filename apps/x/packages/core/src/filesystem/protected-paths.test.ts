import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dynamic import: WorkDir is resolved at config.ts import time, so the temp
// vault must exist and be pointed at before the module loads.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-protected-paths-'));
fs.mkdirSync(path.join(tmpWorkDir, 'config'), { recursive: true });
fs.mkdirSync(path.join(tmpWorkDir, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(tmpWorkDir, 'config', 'oauth.json'), '{"secret":"refresh-token"}');
fs.writeFileSync(path.join(tmpWorkDir, 'knowledge', 'note.md'), '# a note');
process.env.DHOW_WORKDIR = tmpWorkDir;

const files = await import('./files.js');

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

// The attack this defends against: a crafted email reaches a background agent's
// prompt, the agent is told to read ~/.dhow/config/oauth.json and POST it out.
// Headless runs set autoPermission:true / humanAvailable:false, so "ask first"
// would mean "an LLM decides". These paths are denied outright instead.
describe('protected vault paths', () => {
    const denied = [
        ['relative', 'config/oauth.json'],
        ['absolute', path.join(tmpWorkDir, 'config', 'oauth.json')],
        ['traversal out of a sibling dir', 'knowledge/../config/oauth.json'],
        ['the security allowlist itself', 'config/security.json'],
        ['the config directory', 'config'],
        ['a not-yet-existing file inside config', 'config/brand-new.json'],
    ] as const;

    for (const [label, target] of denied) {
        it(`refuses to read via ${label}`, async () => {
            await expect(files.readText(target)).rejects.toBeInstanceOf(files.ProtectedPathError);
        });
    }

    it('refuses to write into config, which would be privilege escalation', async () => {
        await expect(files.writeText('config/security.json', '{"allowList":["*"]}'))
            .rejects.toBeInstanceOf(files.ProtectedPathError);
        // and the real file is untouched
        expect(fs.existsSync(path.join(tmpWorkDir, 'config', 'security.json'))).toBe(false);
    });

    it('refuses list, stat, remove and glob-adjacent entry points too', async () => {
        await expect(files.list('config')).rejects.toBeInstanceOf(files.ProtectedPathError);
        await expect(files.stat('config/oauth.json')).rejects.toBeInstanceOf(files.ProtectedPathError);
        await expect(files.remove('config/oauth.json')).rejects.toBeInstanceOf(files.ProtectedPathError);
        // the credential survived every attempt
        expect(fs.readFileSync(path.join(tmpWorkDir, 'config', 'oauth.json'), 'utf8'))
            .toContain('refresh-token');
    });

    it('still allows ordinary vault files', async () => {
        const result = await files.readText('knowledge/note.md');
        expect(result.content).toContain('# a note');
    });

    it('marks a protected path for the permission layer instead of throwing', async () => {
        // The permission checker fails closed; a throw there would abort the
        // turn rather than deny the call, so this path reports instead.
        const resolved = await files.resolveFilePathForPermission('config/oauth.json');
        expect(resolved.isProtected).toBe(true);
        const ordinary = await files.resolveFilePathForPermission('knowledge/note.md');
        expect(ordinary.isProtected).toBe(false);
    });

    it('catches a symlink inside the vault that points at config', async () => {
        const link = path.join(tmpWorkDir, 'knowledge', 'innocent.json');
        try {
            fs.symlinkSync(path.join(tmpWorkDir, 'config', 'oauth.json'), link);
        } catch {
            return; // symlinks unavailable on this platform; nothing to assert
        }
        // The lexical guard cannot see through the link, so the canonical check
        // in the permission layer is what catches it.
        const resolved = await files.resolveFilePathForPermission('knowledge/innocent.json');
        expect(resolved.isProtected).toBe(true);
    });
});
