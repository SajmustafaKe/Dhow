import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/app/lib/supabase";

/**
 * Only a same-origin path is a safe redirect target after the OAuth
 * handshake. Anything else — an absolute URL, a protocol-relative
 * `//evil.com`, a backslash trick (`/\evil.com` normalizes to `//evil.com`
 * for special schemes), or a bogus scheme (`javascript:`, `data:`) — is an
 * open-redirect vector: an attacker crafts
 * `/auth/callback?code=<theirs>&next=https://evil.com` and rides a
 * legitimate login through to a phishing page with the victim's session
 * cookie already set on this origin. Resolve against the real origin and
 * reject anything that doesn't come back to it, rather than pattern-matching
 * the raw string (which backslash/whitespace tricks defeat).
 */
function safeRedirectPath(next: string | null, origin: string): string {
    if (!next) {
        return "/";
    }
    try {
        const resolved = new URL(next, origin);
        return resolved.origin === origin ? resolved.pathname + resolved.search + resolved.hash : "/";
    } catch {
        return "/";
    }
}

export async function GET(request: NextRequest) {
    const { searchParams, origin } = request.nextUrl;
    const code = searchParams.get("code");
    const next = safeRedirectPath(searchParams.get("next") ?? searchParams.get("returnTo"), origin);

    // A missing or empty `code` means there is nothing to exchange — bail
    // out to the login page with an error instead of calling
    // exchangeCodeForSession(null-ish), which would either throw or (worse)
    // leave a half-authenticated response in flight.
    if (!code || !code.trim()) {
        return NextResponse.redirect(new URL("/auth/login?error=missing_code", origin));
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
        return NextResponse.redirect(new URL("/auth/login?error=exchange_failed", origin));
    }

    return NextResponse.redirect(new URL(next, origin));
}
