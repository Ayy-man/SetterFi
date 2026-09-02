import { describe, expect, it } from "vitest";

import type { MessagingCapabilities } from "@/lib/integrations/types";

import {
  deriveCadenceClass,
  resolveChannelCapability,
  type ChannelCapabilityFeed,
} from "./channel-capabilities";

describe("channel capability seam", () => {
  it("defaults SMS to durable freeform and Meta channels to window-bound", () => {
    expect(resolveChannelCapability("sms")).toEqual({
      postWindow: "freeform",
      templateSend: false,
    });
    for (const channel of ["instagram", "messenger", "whatsapp"] as const) {
      expect(resolveChannelCapability(channel)).toEqual({
        postWindow: "none",
        templateSend: false,
      });
      expect(deriveCadenceClass(channel)).toBe("window_bound");
    }
    expect(deriveCadenceClass("sms")).toBe("durable");
  });

  it("derives durable delivery only from the frozen Phase 4 capability shape", () => {
    const feed: ChannelCapabilityFeed = {
      instagram: { windowed: false, postWindow: "none", templates: false },
      whatsapp: { windowed: true, postWindow: "template", templates: true },
    };
    expect(resolveChannelCapability("instagram", feed)).toEqual({
      postWindow: "freeform",
      templateSend: false,
    });
    expect(resolveChannelCapability("whatsapp", feed)).toEqual({
      postWindow: "template",
      templateSend: true,
    });
    expect(deriveCadenceClass("instagram", feed)).toBe("durable");
    expect(deriveCadenceClass("whatsapp", feed)).toBe("durable");
  });

  it("keeps human tags outside automation and incomplete template data fail-closed", () => {
    const humanOnly: ChannelCapabilityFeed = {
      messenger: { windowed: true, postWindow: "human_tag", templates: false },
    };
    expect(resolveChannelCapability("messenger", humanOnly)).toEqual({
      postWindow: "human_agent_only",
      templateSend: false,
    });
    expect(deriveCadenceClass("messenger", humanOnly)).toBe("window_bound");

    const inconsistent: ChannelCapabilityFeed = {
      whatsapp: { windowed: true, postWindow: "template", templates: false },
    };
    expect(resolveChannelCapability("whatsapp", inconsistent)).toEqual({
      postWindow: "none",
      templateSend: false,
    });
  });

  it("collapses unknown channels and malformed feed entries instead of expanding sends", () => {
    expect(resolveChannelCapability("webchat")).toEqual({
      postWindow: "none",
      templateSend: false,
    });
    expect(deriveCadenceClass("webchat")).toBe("none");

    const malformed = {
      sms: { windowed: true, postWindow: "template" },
    } as unknown as ChannelCapabilityFeed;
    expect(resolveChannelCapability("sms", malformed)).toEqual({
      postWindow: "freeform",
      templateSend: false,
    });
  });

  it("does not let partial template capability become an approved template send", () => {
    const partial = {
      windowed: true,
      postWindow: "template",
      templates: undefined,
    } as unknown as MessagingCapabilities;
    expect(resolveChannelCapability("whatsapp", { whatsapp: partial })).toEqual({
      postWindow: "none",
      templateSend: false,
    });
  });
});
