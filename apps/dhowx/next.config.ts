import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Was `output: "export"`. This app began as a static v0.dev prototype with no
  // server, so a static export was sufficient. It is now the trunk that
  // apps/dhow's 17 API routes, Auth0 session handling and server actions get
  // ported into, none of which Next will build under `export`.
  // `standalone` matches what apps/dhow already ships.
  output: "standalone",
  turbopack: {
    // Keep Turbopack scoped to this app instead of inferring a parent workspace root.
    root: __dirname || path.join(process.cwd()),
  },
};

export default nextConfig;
