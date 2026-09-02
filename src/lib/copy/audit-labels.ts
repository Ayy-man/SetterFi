import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";

export function auditActionLabel(key: AuditActionKey): string {
  const action = AUDIT_ACTIONS[key];
  return `${action.microcopy}: ${action.ariaLabel}`;
}
