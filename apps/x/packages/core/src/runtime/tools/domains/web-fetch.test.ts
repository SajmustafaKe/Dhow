import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Dynamic import: the module chain reaches config.ts, which resolves WorkDir at
// import time and writes default config files.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-web-fetch-'));
process.env.DHOW_WORKDIR = tmpWorkDir;

const { fetchUrlTools, isBlockedAddress } = await import('./web.js');
const fetchUrl = fetchUrlTools['fetch-url'];

// The catalog types `execute` as a zod z.custom, so the compiler has no
// signature for it. Named cast with a stated reason rather than an inline one:
// the shape is fixed by this file's own tool definition.
type FetchUrlResult = { ok: boolean; status: number; error?: string; body?: string };
const runFetchUrl = fetchUrl.execute as (
    args: { url: string; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchUrlResult>;

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('fetch-url egress guard', () => {
    // It was permission:"none", so an agent acting on untrusted email content
    // could POST anywhere with nothing in the way.
    it('requires approval rather than running unattended', () => {
        expect(fetchUrl.permission).toBe('prompt');
    });

    const blocked: Array<[string, string]> = [
        ['loopback by IP', 'http://127.0.0.1/x'],
        ['loopback by name', 'http://localhost/x'],
        ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
        ['private 10/8', 'http://10.0.0.5/x'],
        ['private 192.168/16', 'http://192.168.1.1/x'],
        ['private 172.16/12', 'http://172.20.10.1/x'],
        ['IPv6 loopback', 'http://[::1]/x'],
        ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/x'],
    ];

    for (const [label, url] of blocked) {
        it(`refuses ${label}`, async () => {
            const res = await runFetchUrl({ url });
            expect(res.ok).toBe(false);
            expect(String(res.error)).toMatch(/private or loopback/i);
        });
    }

    it('refuses non-http schemes', async () => {
        const res = await runFetchUrl({ url: 'file:///etc/passwd' });
        expect(res.ok).toBe(false);
        expect(String(res.error)).toMatch(/Only http\(s\)/);
    });

    // Deterministic, and no network: asserting a public host is *allowed* by
    // actually fetching it would make the suite depend on the internet.
    it('treats publicly routable addresses as allowed', () => {
        for (const addr of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
            expect(isBlockedAddress(addr)).toBe(false);
        }
    });

    it('blocks every private form, including both IPv4-mapped notations', () => {
        for (const addr of [
            '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.10.1', '169.254.169.254',
            '0.0.0.0', '100.64.0.1', '224.0.0.1',
            '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1',
            '::ffff:127.0.0.1',   // readable form
            '::ffff:7f00:1',      // what new URL() normalises it to
        ]) {
            expect(isBlockedAddress(addr), addr).toBe(true);
        }
    });

    // The guard must run BEFORE any socket is opened, otherwise an internal
    // service still receives the request even if the body is discarded.
    it('validates before opening a connection', async () => {
        let reached = false;
        const server = http.createServer((_req, res) => {
            reached = true;
            res.writeHead(200);
            res.end('internal-secret');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('expected a bound TCP port');
        }

        const res = await runFetchUrl({ url: `http://127.0.0.1:${address.port}/` });
        expect(res.ok).toBe(false);
        expect(res.body).toBeUndefined();
        expect(reached).toBe(false);
        server.close();
    });
});
