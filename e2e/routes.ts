export const ADMIN_ROUTES = [
  "/admin/overview",
  "/admin/agent-performance",
  "/admin/brain",
  "/admin/brain/testing",
  "/admin/settings",
  "/admin/alerts",
  "/admin/compliance",
  "/admin/channel-health",
  "/admin/audit",
  "/admin/support",
  "/admin/platform-clients",
  "/admin/system",
  "/admin/help",
  "/admin/tiers",
  "/admin/billing",
  "/admin/corrections",
  "/admin/affiliates",
  "/admin/provisioning",
] as const;

export const COACH_ROUTES = [
  "/coach/home",
  "/coach/pipelines",
  "/coach/conversations",
  "/coach/contacts",
  "/coach/agent",
  "/coach/integrations",
  "/coach/get-started",
  "/coach/billing",
  "/coach/settings",
  "/coach/help",
] as const;

export const AFFILIATE_ROUTES = ["/affiliate"] as const;

export const PUBLIC_ROUTES = ["/", "/login", "/signup", "/consumer", "/onboarding"] as const;

export const ALIAS_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["/admin", "/admin/overview"],
  ["/admin/agent-defaults", "/admin/brain"],
  ["/admin/brain/ops", "/admin/brain"],
  ["/admin/evals", "/admin/brain/testing"],
  ["/admin/clients", "/admin/platform-clients"],
  ["/admin/leads", "/admin/compliance"],
  ["/admin/leads-compliance", "/admin/compliance"],
  ["/admin/inbox", "/admin/support"],
  ["/admin/attention", "/admin/support"],
  ["/admin/needs-attention", "/admin/support"],
  ["/admin/tiers-billing", "/admin/tiers"],
  ["/admin/settings", "/admin/alerts"],
  ["/coach/my-agent", "/coach/agent"],
  ["/coach/analytics", "/coach/home"],
];
