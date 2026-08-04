import type { MetadataRoute } from "next";

// APP_URL first -- see app/robots.ts and app/api/v1/config/route.ts.
const siteUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://dhow.io";

/**
 * Marketing routes only. The hosted workspace behind /auth is private, and
 * /demo is a prototype excluded in robots.ts — neither belongs here.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${siteUrl}/privacy`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${siteUrl}/terms`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
