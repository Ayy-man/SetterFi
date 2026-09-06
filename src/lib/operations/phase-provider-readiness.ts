import type { EnvironmentSource } from "@/lib/env-contract";
import {
  EMAIL_CONFIGURATION_NAMES, GHL_AGENCY_OAUTH_CONFIGURATION_NAMES,
  GHL_AGENT_OAUTH_CONFIGURATION_NAMES, GHL_CONFIGURATION_NAMES,
  GHL_PROVISIONING_CONFIGURATION_NAMES, META_CONFIGURATION_NAMES,
  META_OAUTH_CONFIGURATION_NAMES, META_WHATSAPP_CONFIGURATION_NAMES,
} from "@/lib/integrations/selector";
import { STRIPE_CONFIGURATION_NAMES } from "@/lib/integrations/stripe/selector";

export type PhaseProviderIssue = {
  label: string;
  reason: "not_selected" | "mock" | "invalid" | "missing_configuration";
  missingNames: readonly string[];
};

export type PhaseProviderReadiness = {
  phase: number;
  flag: string;
  enabled: boolean;
  paths: readonly string[];
  issues: readonly PhaseProviderIssue[];
};

type Requirement = {
  label: string;
  selector: string;
  names: readonly string[];
  when?: string;
};

const GHL = { label: "Text messaging and connected calendar actions", selector: "SETTERFI_GHL_DRIVER", names: GHL_CONFIGURATION_NAMES };
const MODEL = { label: "AI replies and evaluations", selector: "SETTERFI_OPENROUTER_DRIVER", names: ["OPENROUTER_API_KEY"] };
const PHASES: readonly { paths: readonly string[]; requirements: readonly Requirement[] }[] = [
  { paths: ["/coach/home", "/coach/inbox", "/coach/agent", "/coach/leads", "/admin/channel-health"], requirements: [GHL, MODEL] },
  { paths: ["/admin/brain", "/coach/agent"], requirements: [
    { label: "Knowledge indexing", selector: "SETTERFI_EMBEDDINGS_DRIVER", names: ["OPENROUTER_API_KEY"] },
    { label: "Notion knowledge imports", selector: "SETTERFI_NOTION_DRIVER", names: ["NOTION_API_KEY", "NOTION_KB_ROOT_ID"] },
  ] },
  { paths: ["/admin/compliance", "/admin/followup-copy", "/coach/agent", "/coach/leads"], requirements: [GHL] },
  { paths: ["/admin/channel-health", "/coach/agent", "/coach/inbox", "/coach/get-started", "/onboarding"], requirements: [
    { label: "Instagram and Messenger actions", selector: "SETTERFI_META_DRIVER", names: META_CONFIGURATION_NAMES },
    { label: "WhatsApp setup", selector: "SETTERFI_META_DRIVER", names: [...META_OAUTH_CONFIGURATION_NAMES, ...META_WHATSAPP_CONFIGURATION_NAMES], when: "SETTERFI_WHATSAPP_EMBEDDED_SIGNUP" },
  ] },
  { paths: ["/admin/provisioning", "/admin/platform-clients", "/coach/get-started", "/onboarding"], requirements: [
    { label: "Automatic workspace provisioning", selector: "SETTERFI_GHL_PROVISIONING_DRIVER", names: GHL_PROVISIONING_CONFIGURATION_NAMES },
  ] },
  { paths: ["/admin/tiers", "/admin/billing", "/admin/affiliates", "/coach/billing", "/affiliate", "/onboarding"], requirements: [
    { label: "Live subscription payments", selector: "SETTERFI_STRIPE_DRIVER", names: STRIPE_CONFIGURATION_NAMES, when: "SETTERFI_PHASE6_STRIPE_LIVE" },
  ] },
  { paths: ["/admin/overview", "/admin/agent-performance", "/admin/brain", "/coach/agent"], requirements: [
    { ...MODEL, when: "SETTERFI_PHASE7_EVALS_LIVE" },
    { ...MODEL, when: "SETTERFI_PHASE7_MEET_AGENT_LIVE" },
  ] },
  { paths: ["/admin/alerts", "/admin/help", "/admin/support", "/admin/inbox", "/coach/help"], requirements: [
    { label: "Email notification delivery", selector: "SETTERFI_EMAIL_DRIVER", names: EMAIL_CONFIGURATION_NAMES, when: "SETTERFI_PHASE8_ALERTS_LIVE" },
    { ...MODEL, when: "SETTERFI_PHASE8_ENGINE_EVAL_LIVE" },
  ] },
  { paths: ["/admin/provisioning", "/admin/platform-clients", "/admin/channel-health"], requirements: [
    { label: "Workspace connection setup", selector: "SETTERFI_GHL_DRIVER", names: [...GHL_CONFIGURATION_NAMES, ...GHL_AGENT_OAUTH_CONFIGURATION_NAMES, ...GHL_AGENCY_OAUTH_CONFIGURATION_NAMES], when: "SETTERFI_PHASE9_GHL_OAUTH_LIVE" },
  ] },
];

/** Configuration only. A configured provider is not evidence of an install or a successful call. */
export function phaseProviderReadiness(environment: EnvironmentSource = process.env): PhaseProviderReadiness[] {
  const value = (name: string) => environment[name]?.trim();
  return PHASES.map((definition, index) => {
    const phase = index + 1;
    const flag = `SETTERFI_PHASE${phase}_LIVE`;
    const enabled = value(flag) === "true";
    const issues: PhaseProviderIssue[] = [];
    if (enabled) for (const requirement of definition.requirements) {
      if (requirement.when && value(requirement.when) !== "true") continue;
      const selection = value(requirement.selector);
      const offline = requirement.selector === "SETTERFI_NOTION_DRIVER" && selection === "offline";
      const names = offline ? ["NOTION_EXPORT_PATH"] : requirement.names;
      const missingNames = names.filter((name) => !value(name));
      const reason = !selection ? "not_selected"
        : selection === "mock" ? "mock"
          : selection !== "real" && !offline ? "invalid"
            : missingNames.length ? "missing_configuration" : null;
      if (reason && !issues.some((issue) => issue.label === requirement.label)) {
        issues.push({ label: requirement.label, reason,
          missingNames: [...new Set([...(reason === "missing_configuration" ? [] : [requirement.selector]), ...missingNames])],
        });
      }
    }
    return { phase, flag, enabled, paths: definition.paths, issues };
  });
}
