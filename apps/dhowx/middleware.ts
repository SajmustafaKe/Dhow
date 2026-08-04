import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

const corsOptions = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-client-id, Authorization',
}

/**
 * Refreshes the Supabase session cookie for the current request (the
 * `@supabase/ssr` middleware pattern) and reports whether a user is signed
 * in. `response` carries the refreshed Set-Cookie headers and must be
 * returned (or its cookies copied onto whatever is returned) so the browser
 * picks up the renewed token.
 */
async function refreshSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  return { response, user };
}

async function authCheck(request: NextRequest) {
  const { response, user } = await refreshSession(request);
  if (!user) {
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('returnTo', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }
  return response;
}

export async function middleware(request: NextRequest) {
  // Check if the request path starts with /api/
  if (request.nextUrl.pathname.startsWith('/api/')) {
    // Handle preflighted requests
    if (request.method === 'OPTIONS') {
      const preflightHeaders = {
        'Access-Control-Allow-Origin': '*',
        ...corsOptions,
      }
      return NextResponse.json({}, { headers: preflightHeaders });
    }

    // Handle simple requests
    const response = NextResponse.next();

    // Set CORS headers for all origins
    response.headers.set('Access-Control-Allow-Origin', '*');

    Object.entries(corsOptions).forEach(([key, value]) => {
      response.headers.set(key, value);
    })

    return response;
  }

  if (request.nextUrl.pathname.startsWith('/projects') ||
    request.nextUrl.pathname.startsWith('/billing') ||
    request.nextUrl.pathname.startsWith('/onboarding')) {
    // Skip auth check if USE_AUTH is not enabled
    if (process.env.USE_AUTH === 'true') {
      return await authCheck(request);
    }
  }

  // Refresh the session cookie on every other route too (including /auth/*)
  // so the browser client always has a fresh token; the route itself (e.g.
  // app/auth/callback/route.ts) owns the actual sign-in/out flow.
  const { response } = await refreshSession(request);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
