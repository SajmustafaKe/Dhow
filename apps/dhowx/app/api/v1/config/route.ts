import { NextResponse } from "next/server";

/**
 * GET /api/v1/config
 *
 * Bootstrap endpoint the desktop app (apps/x) fetches at startup to
 * discover its identity provider at runtime, instead of baking an issuer
 * into the build. RowBoat's desktop did this by fetching
 * `${API_URL}/v1/config`, parsing it with `RowboatApiConfig`, and reading
 * `supabaseUrl` off it to build the OIDC discovery URL
 * (`${supabaseUrl}/auth/v1/.well-known/oauth-authorization-server`) — see
 * `apps/x/packages/core/src/config/rowboat.ts` and `auth/providers.ts` at
 * git commit `dd9e0668^`.
 *
 * PATH NOTE: this file lives at `app/api/v1/config/route.ts`, so Next's
 * app router serves it at `/api/v1/config` — NOT `/v1/config`. The
 * desktop's `API_URL` must resolve to a base that this path sits under
 * (e.g. `API_URL` already includes the `/api` segment, or the desktop
 * fetches `${API_URL}/api/v1/config`). See this slice's final report for
 * the explicit path to wire up.
 *
 * UNAUTHENTICATED BY DESIGN: a client that has not signed in yet must be
 * able to call this to learn where to sign in. That means the payload may
 * only ever contain values that are safe to hand to an anonymous caller —
 * never a service-role key, an anon key, or any other secret. Every field
 * added here must be public by construction.
 *
 * Kept additive: RowBoat's `RowboatApiConfig` also carried `billing` and
 * `modelRecommendations`. Adding either later means adding a field to the
 * object below plus updating this route's characterization test — the
 * test pins the response's key set exactly, so growing the payload is a
 * deliberate, reviewable change rather than an accident.
 */
export async function GET() {
    // RUNTIME FIRST, BUILD-TIME FALLBACK.
    //
    // `NEXT_PUBLIC_*` is inlined by the bundler at build time, even inside a
    // server route. Setting it in the process environment at boot does
    // nothing -- verified empirically: a standalone build started with a
    // different NEXT_PUBLIC_SUPABASE_URL still served the value it was built
    // with. That is fatal for THIS route specifically, whose entire purpose
    // is to let the desktop app discover its identity provider at runtime so
    // that rotating the Supabase project never requires shipping a new
    // desktop build. A bootstrap endpoint frozen at build time is a
    // contradiction.
    //
    // So: prefer the unprefixed names, which are read from the real process
    // environment and can be set per-deployment. Fall back to the
    // NEXT_PUBLIC_ ones so existing builds and local dev keep working
    // unchanged.
    //
    // NEXT_PUBLIC_SUPABASE_URL must keep its prefix elsewhere -- the login
    // page and user-provider are client components and genuinely need it in
    // the bundle. NEXT_PUBLIC_APP_URL has no client consumer at all (only
    // robots.ts, sitemap.ts, layout.tsx and this route), so APP_URL is the
    // better name everywhere it is read.
    const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

    const missing = [
        !appUrl && "APP_URL (or NEXT_PUBLIC_APP_URL)",
        !supabaseUrl && "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)",
    ].filter((name): name is string => Boolean(name));

    if (missing.length > 0) {
        console.error(`/api/v1/config: missing required env var(s): ${missing.join(", ")}`);
        return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }

    return NextResponse.json({ appUrl, supabaseUrl });
}
