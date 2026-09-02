export const FAILURE_BODY = {
  agent: "No agent action was completed by this error state.",
  billing: "No billing action was completed by this error state.",
  billingUnavailable: "No subscription, invoice, allowance, or delivery value is estimated.",
  client: "No client action was completed by this error state.",
  platform: "No agent, billing, or client action was completed by this error state.",
} as const

export type FailureScope = keyof typeof FAILURE_BODY
