/** Template routes expose persisted lifecycle only; clients cannot choose an approval state. */

import type { AuditActionKey } from "@/lib/audit/actions";
import { phase4Live } from "@/lib/env-contract";
import {
  IDENTITY_PROVIDERS,
  MESSAGING_CHANNELS,
  type IdentityProvider,
  type MessagingChannel,
} from "@/lib/integrations/types";
import {
  listMessageTemplates,
  MESSAGE_TEMPLATE_CATEGORIES,
  submitMessageTemplate,
  type MessageTemplateCategory,
  type MessageTemplateView,
} from "@/lib/repositories/message-templates";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";

const noStoreHeaders = { "Cache-Control": "no-store" };
const TEMPLATE_SUBMITTED_ACTION = "message_template.submitted" satisfies AuditActionKey;

type MessageTemplateRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  list(tenantId: string): Promise<MessageTemplateView[]>;
  submit(input: Parameters<typeof submitMessageTemplate>[0]): Promise<MessageTemplateView>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isChannel(value: unknown): value is MessagingChannel {
  return typeof value === "string" && MESSAGING_CHANNELS.includes(value as MessagingChannel);
}

function isProvider(value: unknown): value is IdentityProvider {
  return typeof value === "string" && IDENTITY_PROVIDERS.includes(value as IdentityProvider);
}

function isCategory(value: unknown): value is MessageTemplateCategory {
  return typeof value === "string" &&
    MESSAGE_TEMPLATE_CATEGORIES.includes(value as MessageTemplateCategory);
}

function templateResponse(template: MessageTemplateView) {
  return {
    id: template.id,
    channel: template.channel,
    providerTemplateName: template.providerTemplateName,
    category: template.category,
    locale: template.locale,
    body: template.body,
    bodyHash: template.bodyHash,
    variables: template.variables,
    status: template.status,
    submittedAt: template.submittedAt,
    approvedAt: template.approvedAt,
    rejectedAt: template.rejectedAt,
    pausedAt: template.pausedAt,
    disabledAt: template.disabledAt,
    statusUpdatedAt: template.statusUpdatedAt,
    rejectionDetail: template.rejectionDetail,
    isDemo: template.isDemo,
    dataLabel: template.dataLabel,
  };
}

export function createMessageTemplateHandlers(dependencies: MessageTemplateRouteDependencies) {
  async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    try {
      const items = await dependencies.list(actor.tenantId);
      return Response.json({ items: items.map(templateResponse) }, { headers: noStoreHeaders });
    } catch (cause) {
      console.error(
        "/api/message-templates failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { error: "Message templates could not be loaded." },
        { status: 503, headers: noStoreHeaders },
      );
    }
  }

  async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    if (hasImpersonationMarker(actor)) {
      return Response.json(
        { error: "Template submission is unavailable while viewing as a coach." },
        { status: 403, headers: noStoreHeaders },
      );
    }

    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || !hasExactKeys(body, [
        "channel",
        "provider",
        "providerTemplateId",
        "providerTemplateName",
        "category",
        "locale",
        "body",
        "variables",
        "idempotencyKey",
      ]) || !isChannel(body.channel) || !isProvider(body.provider) ||
        !nonBlank(body.providerTemplateId) || !nonBlank(body.providerTemplateName) ||
        !isCategory(body.category) || !nonBlank(body.locale) || !nonBlank(body.body) ||
        !Array.isArray(body.variables) || !nonBlank(body.idempotencyKey)) {
        throw new Error("MESSAGE_TEMPLATE_BODY_INVALID");
      }
      const template = await dependencies.submit({
        expectedTenantId: actor.tenantId,
        channel: body.channel,
        provider: body.provider,
        providerTemplateId: body.providerTemplateId.trim(),
        providerTemplateName: body.providerTemplateName.trim(),
        category: body.category,
        locale: body.locale.trim(),
        body: body.body.trim(),
        variables: body.variables,
        actorUserId: actor.userId,
        idempotencyKey: body.idempotencyKey.trim(),
      });
      if (template.status !== "submitted") throw new Error("MESSAGE_TEMPLATE_STATUS_INVALID");
      return Response.json({
        template: templateResponse(template),
        audit: { action: TEMPLATE_SUBMITTED_ACTION },
      }, { status: 201, headers: noStoreHeaders });
    } catch {
      return Response.json(
        { error: "Message template submission was refused.", code: "MESSAGE_TEMPLATE_REFUSED" },
        { status: 400, headers: noStoreHeaders },
      );
    }
  }

  return { GET, POST };
}

const handlers = createMessageTemplateHandlers({
  enabled: phase4Live,
  session: loadRouteActor,
  list: listMessageTemplates,
  submit: submitMessageTemplate,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
