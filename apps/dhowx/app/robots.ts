import type { MetadataRoute } from "next";

// APP_URL first: NEXT_PUBLIC_* is inlined at build time even in server code,
// so a build made on a laptop bakes whatever .env.local said and advertises
// it forever. See app/api/v1/config/route.ts for the full reasoning.
const siteUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://dhow.io";

/**
 * /demo is the inherited v0.dev prototype (moved from app/page.tsx during
 * the item-1/item-4 waves) — a working reference for AI Elements
 * composition, not a product page. It stays reachable at that path but is
 * excluded from crawling and from the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/", "/demo"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
