import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client, wired to Next's request cookie jar via
 * `@supabase/ssr`. Safe to call from Server Components, Server Actions, and
 * Route Handlers. Not usable from 'use client' components — those need a
 * separate browser client built with `createBrowserClient`.
 */
export async function createClient() {
    const cookieStore = await cookies();

    return createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        );
                    } catch {
                        // `set` was called from a Server Component, which can't
                        // write response cookies. Harmless as long as
                        // middleware.ts is refreshing the session on every
                        // request (it is) — the cookie still gets refreshed
                        // there.
                    }
                },
            },
        }
    );
}

/**
 * Resolves "who is calling" for the current request, mirroring the shape
 * the previous identity provider's session lookup used to return (`{ user:
 * { id, email, name } } | null`) so callers didn't need a wider rewrite than
 * the identity swap.
 *
 * Deliberately uses `supabase.auth.getUser()`, not `.getSession()`: getUser()
 * revalidates the JWT against the Supabase Auth server on every call instead
 * of trusting the locally-decoded cookie payload, which matters because this
 * runs on every server component / server action that gates on identity.
 */
export async function getSession(): Promise<{ user: { id: string; email?: string; name?: string } } | null> {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
        return null;
    }

    return {
        user: {
            id: data.user.id,
            email: data.user.email,
            name: typeof data.user.user_metadata?.name === "string" ? data.user.user_metadata.name : undefined,
        },
    };
}
