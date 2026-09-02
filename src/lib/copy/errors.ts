export type UserFacingError = {
  title: string;
  body: string;
  retry: boolean;
  code: string;
};

type ErrorDefinition = Omit<UserFacingError, "code">;

const GENERIC_ERROR: ErrorDefinition = {
  title: "Something went wrong",
  body: "Something went wrong while this view was working. Nothing changed. Try again, or contact support if the problem continues.",
  retry: true,
};

const ERRORS: Record<string, ErrorDefinition> = {
  OFFER_DRAFT_READBACK_INCOMPLETE: {
    title: "Draft save not confirmed",
    body: "We could not confirm the saved draft. This screen did not replace the draft you were editing. Review your entries and try saving again.",
    retry: true,
  },
  OFFER_PUBLISH_RECEIPT_INCOMPLETE: {
    title: "Offer publish not confirmed",
    body: "We could not confirm the publish receipt. This screen did not mark the offer as live. Refresh the page before trying again.",
    retry: true,
  },
  OFFER_SAVE_REFUSED: {
    title: "Offer could not be saved",
    body: "One or more offer fields could not be saved. No draft change was confirmed. Review the offer fields and try saving again.",
    retry: true,
  },
  OFFER_PUBLISH_REFUSED: {
    title: "Offer could not be published",
    body: "The draft could not be published. No offer change was made live. Refresh the view and review the draft before trying again.",
    retry: true,
  },
  OFFER_READ_FAILED: {
    title: "Offer could not load",
    body: "The saved offer could not load. No offer content was changed. Retry the view.",
    retry: true,
  },
  PLATFORM_PREVIEW_READ_FAILED: {
    title: "Overview could not load",
    body: "The platform overview could not load. No agent, billing, or client action was completed. Retry the view.",
    retry: true,
  },
  ADMIN_BRAIN_READ_FAILED: {
    title: "The Brain could not load",
    body: "The Brain could not load. No content in The Brain was changed. Retry the view.",
    retry: true,
  },
  BILLING_CORRECTIONS_READ_FAILED: {
    title: "Billing corrections could not load",
    body: "Billing corrections could not load. No billing correction was applied. Retry the view.",
    retry: true,
  },
  COMPLIANCE_READ_FAILED: {
    title: "Compliance records could not load",
    body: "Compliance records could not load. No compliance setting was changed. Retry the view.",
    retry: true,
  },
  TEST_AGENT_SESSION_REFUSED: {
    title: "Test session could not start",
    body: "The test session could not start. No message was sent to a lead. Review the setup and try again.",
    retry: true,
  },
  HTTP_401: {
    title: "Sign in required",
    body: "We could not verify your session. No account change was made. Sign in again and repeat the action.",
    retry: false,
  },
  HTTP_403: {
    title: "Action not permitted",
    body: "Your account does not have access to this action. No account or workspace change was made. Return to the previous page or ask an administrator for access.",
    retry: false,
  },
  HTTP_404: {
    title: "Item not found",
    body: "The requested item could not be found. No change was made. Return to the previous page and choose another item.",
    retry: false,
  },
  HTTP_409: {
    title: "Refresh required",
    body: "The item changed after this view loaded. Your requested change was not applied. Refresh the view and try again.",
    retry: true,
  },
  HTTP_500: {
    title: "Request could not finish",
    body: "The service could not finish the request. No change was confirmed. Try again.",
    retry: true,
  },
  HTTP_503: {
    title: "Service temporarily unavailable",
    body: "The service is temporarily unable to handle the request. No change was confirmed. Try again in a moment.",
    retry: true,
  },
  FETCH_TIMEOUT: {
    title: "Request timed out",
    body: "The service did not respond in time. No change was confirmed. Check your connection and try again.",
    retry: true,
  },
};

function bodyForField(body: string, field?: string) {
  const label = field?.trim();
  if (!label) return body;

  const firstSentenceEnd = body.indexOf(". ");
  const remainder = firstSentenceEnd === -1 ? "" : body.slice(firstSentenceEnd + 2);
  return `We could not finish updating ${label}.${remainder ? ` ${remainder}` : ""}`;
}

export function humanError(code: string, context?: { field?: string }): UserFacingError {
  const stableCode = code.split(":", 1)[0];
  const definition = ERRORS[stableCode] ?? GENERIC_ERROR;

  return {
    ...definition,
    body: bodyForField(definition.body, context?.field),
    code,
  };
}
