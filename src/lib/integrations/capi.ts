import { createHash } from "node:crypto";

export const CAPI_EVENT_NAMES = ["QualifiedLead", "Purchase"] as const;
export const CAPI_MESSAGING_CHANNELS = ["messenger", "instagram", "whatsapp"] as const;

export type CapiEventName = (typeof CAPI_EVENT_NAMES)[number];
export type CapiMessagingChannel = (typeof CAPI_MESSAGING_CHANNELS)[number];

type MessengerIdentity = {
  channel: "messenger";
  pageId: string;
  pageScopedUserId: string;
};

type InstagramIdentity = {
  channel: "instagram";
  instagramBusinessAccountId: string;
  igSid: string;
};

type WhatsAppIdentity = {
  channel: "whatsapp";
  whatsappBusinessAccountId: string;
  ctwaClid: string;
};

export type CapiUserIdentity = MessengerIdentity | InstagramIdentity | WhatsAppIdentity;

export type CapiEvent = {
  datasetId: string;
  eventName: CapiEventName;
  eventTime: string;
  identity: CapiUserIdentity;
  currency: string | null;
  value: number | null;
};

export type CapiProviderReceipt = {
  provider: "meta";
  mode: "mock" | "real";
  receiptId: string;
  accepted: true;
  received: number | null;
};

export interface CapiDriver {
  readonly mode: "mock" | "real";
  dispatchEvent(event: CapiEvent): Promise<CapiProviderReceipt>;
}

export class CapiContractError extends Error {
  readonly retryable = false;

  constructor(readonly code: string) {
    super(code);
    this.name = "CapiContractError";
  }
}

export class CapiProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "CapiProviderError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new CapiContractError(code);
  return normalized;
}

function validated(event: CapiEvent) {
  const datasetId = required(event.datasetId, "CAPI_DATASET_ID_REQUIRED");
  if (!CAPI_EVENT_NAMES.includes(event.eventName)) {
    throw new CapiContractError("CAPI_EVENT_NAME_INVALID");
  }
  if (!CAPI_MESSAGING_CHANNELS.includes(event.identity.channel)) {
    throw new CapiContractError("CAPI_MESSAGING_CHANNEL_INVALID");
  }
  const eventTime = new Date(event.eventTime);
  if (Number.isNaN(eventTime.valueOf())) throw new CapiContractError("CAPI_EVENT_TIME_INVALID");
  if ((event.currency === null) !== (event.value === null)) {
    throw new CapiContractError("CAPI_PURCHASE_VALUE_SHAPE_INVALID");
  }
  if (event.eventName === "Purchase") {
    if (!event.currency || event.value === null) {
      throw new CapiContractError("CAPI_PURCHASE_VALUE_UNCONFIGURED");
    }
    if (!/^[A-Z]{3}$/u.test(event.currency) || !Number.isFinite(event.value) || event.value < 0) {
      throw new CapiContractError("CAPI_PURCHASE_VALUE_INVALID");
    }
  } else if (event.currency !== null || event.value !== null) {
    throw new CapiContractError("CAPI_QUALIFIED_VALUE_FORBIDDEN");
  }

  const userData = event.identity.channel === "messenger"
    ? {
        page_id: required(event.identity.pageId, "CAPI_PAGE_ID_REQUIRED"),
        page_scoped_user_id: required(
          event.identity.pageScopedUserId,
          "CAPI_PAGE_SCOPED_USER_ID_REQUIRED",
        ),
      }
    : event.identity.channel === "instagram"
      ? {
          instagram_business_account_id: required(
            event.identity.instagramBusinessAccountId,
            "CAPI_INSTAGRAM_BUSINESS_ACCOUNT_ID_REQUIRED",
          ),
          ig_sid: required(event.identity.igSid, "CAPI_IG_SID_REQUIRED"),
        }
      : {
          whatsapp_business_account_id: required(
            event.identity.whatsappBusinessAccountId,
            "CAPI_WHATSAPP_BUSINESS_ACCOUNT_ID_REQUIRED",
          ),
          ctwa_clid: required(event.identity.ctwaClid, "CAPI_CTWA_CLID_REQUIRED"),
        };

  return {
    datasetId,
    payload: {
      data: [{
        event_name: event.eventName,
        event_time: Math.floor(eventTime.valueOf() / 1_000),
        action_source: "business_messaging",
        messaging_channel: event.identity.channel,
        user_data: userData,
        ...(event.eventName === "Purchase"
          ? { custom_data: { currency: event.currency, value: event.value } }
          : {}),
      }],
    },
  };
}

function mockReceipt(event: CapiEvent): CapiProviderReceipt {
  const canonical = JSON.stringify(validated(event));
  return {
    provider: "meta",
    mode: "mock",
    receiptId: `mock-capi-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`,
    accepted: true,
    received: 1,
  };
}

export function createMockCapiDriver(): CapiDriver {
  return {
    mode: "mock",
    async dispatchEvent(event) {
      return mockReceipt(event);
    },
  };
}

type FetchLike = typeof fetch;

export function createRealCapiDriver(
  configuration: { accessToken: string },
  dependencies: { fetch?: FetchLike } = {},
): CapiDriver {
  const accessToken = required(configuration.accessToken, "CAPI_ACCESS_TOKEN_REQUIRED");
  const fetcher = dependencies.fetch ?? fetch;
  return {
    mode: "real",
    async dispatchEvent(event) {
      const request = validated(event);
      let response: Response;
      try {
        response = await fetcher(
          `https://graph.facebook.com/${encodeURIComponent(request.datasetId)}/events`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request.payload),
          },
        );
      } catch {
        throw new CapiProviderError("CAPI_PROVIDER_NETWORK_FAILED", null, true);
      }
      if (!response.ok) {
        throw new CapiProviderError(
          "CAPI_PROVIDER_REQUEST_FAILED",
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      let received: number | null = null;
      try {
        const body = await response.json() as { events_received?: unknown };
        received = typeof body.events_received === "number" ? body.events_received : null;
      } catch {
        // A successful response may omit JSON. Store only the safe request receipt below.
      }
      return {
        provider: "meta",
        mode: "real",
        receiptId: response.headers.get("x-fb-trace-id")?.slice(0, 200) || "meta-accepted",
        accepted: true,
        received,
      };
    },
  };
}
