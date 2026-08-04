import { NextResponse } from "next/server";

/**
 * Proves this app can host server routes at all.
 *
 * apps/dhowx shipped as `output: "export"` — a static site, where Next refuses
 * to build any `route.ts`. As the trunk it has to receive apps/dhow's 17 API
 * routes, Auth0 session handling and server actions, so the export mode was
 * switched to `standalone`. This route is the check that the switch took: if it
 * disappears from the build manifest, the trunk has silently gone static again
 * and the port is blocked.
 *
 * `force-dynamic` because a route that gets statically prerendered would prove
 * nothing about server capability.
 */
export const dynamic = "force-dynamic";

export function GET() {
    return NextResponse.json({ ok: true, runtime: "server" });
}
