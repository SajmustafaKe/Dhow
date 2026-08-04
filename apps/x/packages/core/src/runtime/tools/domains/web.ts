// Builtin tools: web domain. Entries moved VERBATIM from the historical
// monolith — the merge order in ../builtin-tools.ts preserves the original
// catalog key order (provider-payload bytes; see the key-order test there).

import { z } from "zod";
import * as path from "path";
import * as fs from "fs/promises";
import { WorkDir } from "../../../config/config.js";
import { BuiltinToolsSchema } from "../types.js";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";


export const webSearchTools: z.infer<typeof BuiltinToolsSchema> = {
    'web-search': {
        permission: "none",
        description: 'Search the web for articles, blog posts, papers, companies, people, news, or explore a topic in depth. Returns rich results with full text, highlights, and metadata.',
        inputSchema: z.object({
            query: z.string().describe('The search query'),
            numResults: z.number().optional().describe('Number of results to return (default: 5, max: 20)'),
            category: z.enum(['general', 'company', 'research paper', 'news', 'tweet', 'personal site', 'financial report', 'people']).optional().describe('Search category. Defaults to "general" which searches the entire web. Only use a specific category when the query is clearly about that type (e.g. "research paper" for academic papers, "company" for company info). For everyday queries like weather, restaurants, prices, how-to, etc., use "general" or omit entirely.'),
        }),
        isAvailable: async () => {
            try {
                const exaConfigPath = path.join(WorkDir, 'config', 'exa-search.json');
                const raw = await fs.readFile(exaConfigPath, 'utf8');
                const config = JSON.parse(raw);
                return !!config.apiKey;
            } catch {
                return false;
            }
        },
        execute: async ({ query, numResults, category }: { query: string; numResults?: number; category?: string }) => {
            try {
                const resultCount = Math.min(Math.max(numResults || 5, 1), 20);

                const reqBody: Record<string, unknown> = {
                    query,
                    numResults: resultCount,
                    type: 'auto',
                    contents: {
                        text: { maxCharacters: 1000 },
                        highlights: true,
                    },
                };
                if (category && category !== 'general') {
                    reqBody.category = category;
                }

                // Read API key from config
                const exaConfigPath = path.join(WorkDir, 'config', 'exa-search.json');

                let apiKey: string;
                try {
                    const raw = await fs.readFile(exaConfigPath, 'utf8');
                    const config = JSON.parse(raw);
                    apiKey = config.apiKey;
                } catch {
                    return {
                        success: false,
                        error: `Exa Search API key not configured. Create ${exaConfigPath} with { "apiKey": "<your-key>" }`,
                    };
                }

                if (!apiKey) {
                    return {
                        success: false,
                        error: `Exa Search API key is empty. Set "apiKey" in ${exaConfigPath}`,
                    };
                }

                const response = await fetch('https://api.exa.ai/search', {
                    method: 'POST',
                    headers: {
                        'x-api-key': apiKey,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(reqBody),
                });

                if (!response.ok) {
                    const text = await response.text();
                    return {
                        success: false,
                        error: `Exa Search API error (${response.status}): ${text}`,
                    };
                }

                const data = await response.json() as {
                    results?: Array<{
                        title?: string;
                        url?: string;
                        publishedDate?: string;
                        author?: string;
                        highlights?: string[];
                        text?: string;
                    }>;
                };

                const results = (data.results || []).map((r) => ({
                    title: r.title || '',
                    url: r.url || '',
                    publishedDate: r.publishedDate || '',
                    author: r.author || '',
                    highlights: r.highlights || [],
                    text: r.text || '',
                }));

                return {
                    success: true,
                    query,
                    results,
                    count: results.length,
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },
};

/**
 * Address ranges an agent-driven fetch must never reach: loopback, private and
 * link-local space, and the cloud metadata address. This is an SSRF control —
 * it protects services that trust the local network, including the app's own
 * localhost servers (the Apps host on 127.0.0.1:3210, any local Ollama).
 *
 * It deliberately does NOT try to stop exfiltration to an arbitrary public
 * host: no blocklist can. Keeping credentials out of the agent's reach is what
 * does that (see filesystem/files.ts, PROTECTED_VAULT_SUBPATHS); this narrows
 * the internal blast radius, and `permission: "prompt"` puts a human in front
 * of the rest.
 */
export function isBlockedAddress(addr: string): boolean {
    const v6 = addr.toLowerCase().replace(/%.*$/, '');  // strip zone id
    // An IPv4-mapped address reaches us in either notation, and `new URL()`
    // rewrites the readable one: "::ffff:127.0.0.1" normalises to
    // "::ffff:7f00:1". Matching only the dotted form let loopback straight
    // through, so decode the hex pair back to a v4 quad as well.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    const v4 = isIPv4(addr)
        ? addr
        : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1]
        ?? (mappedHex ? [
            (parseInt(mappedHex[1], 16) >> 8) & 0xff,
            parseInt(mappedHex[1], 16) & 0xff,
            (parseInt(mappedHex[2], 16) >> 8) & 0xff,
            parseInt(mappedHex[2], 16) & 0xff,
        ].join('.') : undefined);

    if (v4) {
        const [a, b] = v4.split('.').map(Number) as [number, number, number, number];
        return a === 0                                  // "this network"
            || a === 10                                 // private
            || a === 127                                // loopback
            || (a === 169 && b === 254)                 // link-local + cloud metadata
            || (a === 172 && b >= 16 && b <= 31)        // private
            || (a === 192 && b === 168)                 // private
            || (a === 100 && b >= 64 && b <= 127)       // CGNAT
            || (a === 198 && (b === 18 || b === 19))    // benchmarking
            || a >= 224;                                // multicast + reserved
    }
    return v6 === '::' || v6 === '::1'
        || /^f[cd]/.test(v6)                            // unique local fc00::/7
        || /^fe[89ab]/.test(v6);                        // link-local fe80::/10
}

/** Throws unless every address the host resolves to is publicly routable. */
async function assertPublicDestination(target: URL): Promise<void> {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('Only http(s) URLs are allowed.');
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    // Resolve first, then judge: a hostname can point anywhere, and checking the
    // literal string would miss both "localhost" aliases and DNS rebinding.
    const addresses = isIPv4(host) || host.includes(':')
        ? [{ address: host }]
        : await lookup(host, { all: true }).catch(() => {
            throw new Error(`Could not resolve ${host}.`);
        });
    const blocked = addresses.filter((a) => isBlockedAddress(a.address));
    if (blocked.length) {
        throw new Error(
            `Refusing to fetch ${target.origin}: it resolves to a private or loopback address `
            + `(${blocked.map((a) => a.address).join(', ')}). Agent fetches are restricted to public hosts.`,
        );
    }
}

export const fetchUrlTools: z.infer<typeof BuiltinToolsSchema> = {
    'fetch-url': {
        // Arbitrary outbound HTTP with an attacker-influenceable URL, method and
        // body is a data-egress primitive. It was "none", which meant an agent
        // acting on untrusted email content could POST anywhere with nothing in
        // the way.
        permission: "prompt",
        description: "Fetch an HTTP(S) URL and return the response body as text. Use this to pull data from web APIs or pages (e.g. a JSON endpoint) — especially in background tasks, which have no shell. GET by default; supports POST with a body. Private, loopback and link-local addresses are refused. Returns { ok, status, statusText, body } (body truncated if very large). For JSON, parse the returned body.",
        inputSchema: z.object({
            url: z.string().describe('The http(s) URL to fetch.'),
            method: z.enum(['GET', 'POST']).optional().describe('HTTP method (default GET).'),
            headers: z.record(z.string(), z.string()).optional().describe('Optional request headers.'),
            body: z.string().optional().describe('Request body (for POST).'),
        }),
        execute: async ({ url, method, headers, body }: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
            try {
                let target = new URL(url);
                const m = (method || 'GET').toUpperCase();
                // Follow redirects by hand so every hop is checked. Left to
                // fetch, a public URL could 302 straight to 169.254.169.254 and
                // the guard above would never see it.
                let res: Response;
                for (let hop = 0; ; hop++) {
                    await assertPublicDestination(target);
                    res = await fetch(target, {
                        method: m,
                        headers,
                        body: m === 'GET' || m === 'HEAD' ? undefined : body,
                        redirect: 'manual',
                    });
                    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
                    if (!location) break;
                    if (hop >= 5) {
                        return { ok: false, status: res.status, error: 'Too many redirects.' };
                    }
                    target = new URL(location, target);
                }
                let text = await res.text();
                const MAX = 200_000;
                const truncated = text.length > MAX;
                if (truncated) text = text.slice(0, MAX);
                return { ok: res.ok, status: res.status, statusText: res.statusText, body: text, truncated };
            } catch (e) {
                return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
            }
        },
    },
};
