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

/**
 * Whether omp can actually start a session — i.e. it has usable model
 * credentials.
 *
 * Claude and Codex write a credential file Dhow can stat (~/.claude, the
 * macOS Keychain, ~/.codex/auth.json). omp does not: its ACP handshake
 * reports that auth comes from "provider keys/OAuth state already configured
 * under ~/.omp", which may be a config file, an env var, or an OAuth blob.
 * Rather than guess at that, ask the agent: a session that opens is proof.
 *
 * Measured cost: ~20s when it succeeds, and an unconfigured omp *hangs* at
 * `session/new` rather than returning an auth error — so a negative verdict
 * is a timeout. That makes this far too slow to block a UI open on. Callers
 * read the last known verdict synchronously and start a refresh separately;
 * `null` means "not established yet", which the UI must not render as a
 * failure.
 */
const AUTH_CACHE_TTL_MS = 10 * 60_000;
const AUTH_PROBE_TIMEOUT_MS = 45_000;
let authCache: { exe: string; ok: boolean; at: number } | null = null;
let inFlight: Promise<boolean> | null = null;

export function invalidateOmpAuthCache(): void {
    authCache = null;
}

/** Last verified verdict, or null when unknown/stale. Never blocks, never spawns. */
export function getOmpAuthState(): boolean | null {
    const exe = resolveOmpExecutable();
    if (!exe) return false;
    if (authCache && authCache.exe === exe && Date.now() - authCache.at < AUTH_CACHE_TTL_MS) {
        return authCache.ok;
    }
    return null;
}

/**
 * Establish the verdict, reusing a fresh cache entry unless `force`.
 * Concurrent callers share one spawn — Settings, the session dialog and the
 * startup warm-up all land on the same probe rather than three omp processes.
 */
export async function checkOmpAuthenticated(
    { force = false, timeoutMs = AUTH_PROBE_TIMEOUT_MS }: { force?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
    const exe = resolveOmpExecutable();
    if (!exe) {
        authCache = null;
        return false;
    }
    if (!force) {
        const cached = getOmpAuthState();
        if (cached !== null) return cached;
        if (inFlight) return inFlight;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const ok = await probeSession(exe, timeoutMs);
            authCache = { exe, ok, at: Date.now() };
            return ok;
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

async function probeSession(exe: string, timeoutMs: number): Promise<boolean> {
    // Imported lazily: this module is loaded by the status probe on startup,
    // and the ACP SDK + child_process plumbing should not be paid for unless
    // an actual auth check runs.
    const { spawn } = await import('child_process');
    const { Writable, Readable } = await import('node:stream');
    const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
    const os = await import('os');

    const env: NodeJS.ProcessEnv = { ...process.env };
    const shellPath = loginShellPath();
    if (shellPath) {
        const dirs = [...shellPath.split(path.delimiter), ...(env.PATH ?? '').split(path.delimiter)];
        env.PATH = [...new Set(dirs.filter(Boolean))].join(path.delimiter);
    }

    const child = spawn(exe, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    // A probe must never surface the agent's noise or crash the host on a
    // broken pipe; we only care whether a session opens.
    child.stderr?.resume();
    child.on('error', () => { /* handled by the race below */ });

    const done = (): void => { try { child.kill(); } catch { /* already gone */ } };

    try {
        const connection = new ClientSideConnection(() => ({
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
            sessionUpdate: async () => {},
            readTextFile: async () => ({ content: '' }),
            writeTextFile: async () => ({}),
        }), ndJsonStream(
            Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        ));

        const deadline = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('omp auth probe timed out')), timeoutMs).unref?.());

        await Promise.race([
            (async () => {
                await connection.initialize({
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
                });
                // A throwaway session in a scratch cwd — we never prompt it.
                await connection.newSession({ cwd: os.tmpdir(), mcpServers: [] });
            })(),
            deadline,
        ]);
        return true;
    } catch {
        // Auth failure, a wedged agent, or a timeout all mean "not usable now".
        return false;
    } finally {
        done();
    }
}
