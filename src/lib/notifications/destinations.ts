import type { WorkspaceRole } from "@/lib/workspace-navigation";

/**
 * The complete set of places a persisted notification may send a signed-in reader.
 *
 * Producers build links from this registry and the bell resolves persisted strings through the
 * same registry before rendering them. That keeps a stale template, an unsafe database value, or
 * a route typo from becoming navigation in the authenticated shell.
 */
export const NOTIFICATION_DESTINATION_REGISTRY = {
  "admin.brain": {
    path: "/admin/brain",
    roles: ["admin"],
    query: [],
  },
  "admin.channel-health": {
    path: "/admin/channel-health",
    roles: ["admin"],
    query: [],
  },
  "coach.billing": {
    path: "/coach/billing",
    roles: ["coach"],
    query: [],
  },
  "coach.conversations": {
    path: "/coach/conversations",
    roles: ["coach"],
    query: [],
  },
  "coach.conversation": {
    path: "/coach/conversations",
    roles: ["coach"],
    query: ["conversationId"],
  },
  "coach.integrations": {
    path: "/coach/integrations",
    roles: ["coach"],
    query: [],
  },
  "coach.integration": {
    path: "/coach/integrations",
    roles: ["coach"],
    query: ["connectionId"],
  },
  "coach.get-started": {
    path: "/coach/get-started",
    roles: ["coach"],
    query: [],
  },
} as const satisfies Record<string, {
  path: `/${string}`;
  roles: readonly WorkspaceRole[];
  query: readonly string[];
}>;

export type NotificationDestinationKey = keyof typeof NOTIFICATION_DESTINATION_REGISTRY;

export type NotificationDestinationInput =
  | { key: "admin.brain" }
  | { key: "admin.channel-health" }
  | { key: "coach.billing" }
  | { key: "coach.conversations" }
  | { key: "coach.conversation"; conversationId: string }
  | { key: "coach.get-started" }
  | { key: "coach.integrations" }
  | { key: "coach.integration"; connectionId: string };

function requiredValue(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`NOTIFICATION_DESTINATION_${field.toUpperCase()}_INVALID`);
  }
  return normalized;
}

function withQuery(path: string, entries: readonly (readonly [string, string])[]) {
  const query = new URLSearchParams();
  for (const [key, value] of entries) query.set(key, requiredValue(value, key));
  return `${path}?${query.toString()}`;
}

export function notificationDestination(input: NotificationDestinationInput): string {
  const definition = NOTIFICATION_DESTINATION_REGISTRY[input.key];
  if (input.key === "coach.conversation") {
    return withQuery(definition.path, [["conversationId", input.conversationId]]);
  }
  if (input.key === "coach.integration") {
    return withQuery(definition.path, [["connectionId", input.connectionId]]);
  }
  return definition.path;
}

function matchesDefinition(
  definition: (typeof NOTIFICATION_DESTINATION_REGISTRY)[NotificationDestinationKey],
  url: URL,
) {
  if (url.pathname !== definition.path || url.hash) return false;
  const expected = new Set<string>(definition.query);
  const found = [...url.searchParams.keys()];
  if (found.length !== expected.size || new Set(found).size !== found.length) return false;
  return found.every((key) => {
    const value = url.searchParams.get(key);
    return expected.has(key) && value !== null && value.trim().length > 0 && value.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(value);
  });
}

/** Returns a canonical internal href only when the persisted value is registered for the reader. */
export function resolveNotificationDestination(
  raw: string | null,
  role: WorkspaceRole,
): string | null {
  if (!raw || raw.length > 1_024 || !raw.startsWith("/") || raw.startsWith("//")
    || raw.includes("\\") || /[\u0000-\u001f\u007f]/u.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, "https://setterfi.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://setterfi.invalid") return null;

  for (const definition of Object.values(NOTIFICATION_DESTINATION_REGISTRY)) {
    const roles: readonly WorkspaceRole[] = definition.roles;
    if (!roles.includes(role) || !matchesDefinition(definition, url)) continue;
    if (definition.query.length === 0) return definition.path;
    const query = new URLSearchParams();
    for (const key of definition.query) query.set(key, url.searchParams.get(key) as string);
    return `${definition.path}?${query.toString()}`;
  }
  return null;
}
