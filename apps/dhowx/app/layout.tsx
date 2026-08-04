import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://dhow.io";

// Renders <meta name="google-site-verification" content="..."> only when the
// env var is set, so Search Console verification never ships a hardcoded
// token — see app/(marketing) for the pages this verifies ownership of.
const googleSiteVerification = process.env.GOOGLE_SITE_VERIFICATION;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Dhow",
    template: "%s | Dhow",
  },
  description:
    "An AI coworker for your inbox, your documents, and your team.",
  ...(googleSiteVerification
    ? { verification: { google: googleSiteVerification } }
    : {}),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
