import fs from 'fs';
import path from 'path';
import { commonInstallPaths } from '../status.js';
import { loginShellPath } from './shell-env.js';

/**
 * Oh My Pi (omp) integration.
 *
 * Unlike Claude Code and Codex — where Dhow stages an ACP adapter package and
 * downloads a pinned native engine into ~/.dhow/engines — omp speaks ACP
 * itself (`omp acp`) and is installed by the user. So there is nothing to
 * provision: we locate the binary and spawn it.
 *
 * It ships through several channels (Homebrew, a global npm install of
 * @oh-my-pi/pi-coding-agent, or a manual drop on PATH), and the shape differs
 * per channel — Homebrew installs a native executable, npm installs a JS entry
 * behind a shim. Discovery therefore goes by name on PATH rather than assuming
 * a layout.
 */

export const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';

export const OMP_INSTALL_HINT =
    `Oh My Pi isn't installed. Install it with \`npm i -g ${OMP_PACKAGE}\` ` +
    `(or \`brew install omp\`), then reopen this dialog.`;

/** Executable names to look for, most specific first. */
function candidateNames(): string[] {
    return process.platform === 'win32' ? ['omp.exe', 'omp.cmd', 'omp.bat'] : ['omp'];
}

function isExecutableFile(p: string): boolean {
    try {
        const st = fs.statSync(p);
        if (!st.isFile()) return false;
        if (process.platform === 'win32') return true;
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Absolute path to the omp executable, or null when it isn't installed.
 *
 * A GUI (Finder/dock) launch inherits launchd's stripped PATH, so the user's
 * shell PATH is probed first — otherwise a perfectly good Homebrew or nvm
 * install looks missing to the app but works in a terminal.
 */
export function resolveOmpExecutable(): string | null {
    const names = candidateNames();

    const searchDirs = [
        ...(loginShellPath() ?? '').split(path.delimiter),
        ...(process.env.PATH ?? '').split(path.delimiter),
    ].filter(Boolean);

    for (const dir of searchDirs) {
        for (const name of names) {
            const full = path.join(dir, name);
            if (isExecutableFile(full)) return full;
        }
    }

    // Fall back to the well-known install locations the agent-status probe
    // already knows about (Homebrew, npm/pnpm global prefixes, ~/.local/bin).
    for (const name of names) {
        for (const candidate of commonInstallPaths(name)) {
            if (isExecutableFile(candidate)) return candidate;
        }
    }

    return null;
}

export function isOmpInstalled(): boolean {
    return resolveOmpExecutable() !== null;
}
