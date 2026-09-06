import type { PhaseProviderReadiness } from "@/lib/operations/phase-provider-readiness";

export function PhaseProviderNotice({ readiness = [], path, technical = false }: {
  readiness?: readonly PhaseProviderReadiness[];
  path: string;
  technical?: boolean;
}) {
  const affected = readiness.filter((phase) => phase.enabled && phase.issues.length > 0
    && (path === "/admin/system" || phase.paths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))));
  if (!affected.length) return null;
  return (
    <aside aria-label="Provider setup required" className="shrink-0 border-b border-[var(--warning-line)] bg-[var(--warning-wash)] px-[var(--s-4)] py-[var(--s-3)] text-[color:var(--warning-text)]">
      <p className="font-medium">Some live actions are unavailable</p>
      <ul className="mt-[var(--s-2)] list-disc space-y-[var(--s-1)] pl-[var(--s-4)]">
        {affected.flatMap((phase) => phase.issues.map((issue) => (
          <li key={`${phase.phase}-${issue.label}`}>
            {issue.label}: {issue.reason === "mock" ? "the provider is in demo mode" : "provider setup is incomplete"}.
            {technical ? <span className="break-words"> {phase.flag} is on; check {issue.missingNames.join(", ")}.</span> : null}
          </li>
        )))}
      </ul>
    </aside>
  );
}
