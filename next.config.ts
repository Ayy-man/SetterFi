import type { NextConfig } from "next";

// The bare domain lands on the role picker in src/app/page.tsx. It must never redirect into the
// admin console, where platform economics live.
const nextConfig: NextConfig = {
  // A production build and `next dev` both own `.next/`, so running the visual suite's
  // `next build && next start` while a dev server is up clobbers that server's output. There is one
  // environment here and often one dev server already running on another port, so the build gets its
  // own output directory on request. Unset -- the default and every deployment -- this is `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Phase 6: dedicated money pages use Next's server-side 403 interrupt before serializing data.
  experimental: { authInterrupts: true },
  redirects: async () => [
    { source: "/admin", destination: "/admin/overview", permanent: false },
    { source: "/admin/agent-defaults", destination: "/admin/brain", permanent: false },
    { source: "/admin/brain/ops", destination: "/admin/brain", permanent: false },
    { source: "/admin/evals", destination: "/admin/brain/testing", permanent: false },
    { source: "/admin/clients", destination: "/admin/platform-clients", permanent: false },
    { source: "/admin/leads", destination: "/admin/compliance", permanent: false },
    { source: "/admin/leads-compliance", destination: "/admin/compliance", permanent: false },
    { source: "/admin/inbox", destination: "/admin/support", permanent: false },
    { source: "/admin/attention", destination: "/admin/support", permanent: false },
    { source: "/admin/needs-attention", destination: "/admin/support", permanent: false },
    { source: "/admin/tiers-billing", destination: "/admin/tiers", permanent: false },
    { source: "/admin/settings", destination: "/admin/alerts", permanent: false },
    { source: "/coach/my-agent", destination: "/coach/agent", permanent: false },
    { source: "/coach/analytics", destination: "/coach/home", permanent: false },
  ],
};

export default nextConfig;
