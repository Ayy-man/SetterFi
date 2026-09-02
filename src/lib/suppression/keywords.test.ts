import { describe, expect, it } from "vitest";

import { classifySuppressionKeyword } from "@/lib/suppression/keywords";
import {
  normalizeControlText,
  normalizeSuppressionIdentifier,
} from "@/lib/suppression/normalize";

describe("classifySuppressionKeyword", () => {
  it.each([
    "STOP",
    "stop!!!",
    "𝗦𝗧𝗢𝗣",
    "opt out please",
    "STOPALL",
    "unsubscribe thanks",
    "ALTO",
    "parar",
  ])("recognizes a normalized exact STOP keyword: %s", (body) => {
    expect(classifySuppressionKeyword("sms", body)).toMatchObject({
      kind: "stop",
      tier: "keyword",
    });
  });

  it.each([
    "don't text me",
    "do not message me please",
    "take me off your list",
    "leave me alone thanks",
    "stop contacting me",
    "no more texts",
  ])("recognizes a deterministic revocation intent without a model call: %s", (body) => {
    expect(classifySuppressionKeyword("instagram", body)).toMatchObject({
      kind: "stop",
      tier: "intent",
    });
  });

  it.each([
    "don't stop",
    "stop by my office at 3",
    "I want to end my contract",
    "unstoppable",
    "the bus stop is nearby",
    "please help me understand the offer",
  ])("does not substring-match a non-revocation: %s", (body) => {
    expect(classifySuppressionKeyword("sms", body)).toEqual({ kind: "none" });
  });

  it("treats HELP and START as phone-channel controls rather than ordinary Meta chat", () => {
    expect(classifySuppressionKeyword("sms", "HELP")).toEqual({ kind: "help", matched: "help" });
    expect(classifySuppressionKeyword("whatsapp", "START please")).toEqual({
      kind: "start",
      matched: "start",
    });
    expect(classifySuppressionKeyword("instagram", "help")).toEqual({ kind: "none" });
    expect(classifySuppressionKeyword("messenger", "start")).toEqual({ kind: "none" });
  });
});

describe("suppression normalization", () => {
  it("normalizes Unicode, punctuation, emoji, case, and whitespace once", () => {
    expect(normalizeControlText("  ＳＴＯＰ 🛑 !!!  ")).toBe("stop");
  });

  it("makes phone-bearing channels share one E.164 identity while retaining Meta ids", () => {
    expect(normalizeSuppressionIdentifier("sms", "+1 (555) 555-0100")).toBe("+15555550100");
    expect(normalizeSuppressionIdentifier("whatsapp", "+1-555-555-0100")).toBe("+15555550100");
    expect(normalizeSuppressionIdentifier("instagram", " synthetic-meta-id ")).toBe("synthetic-meta-id");
    expect(normalizeSuppressionIdentifier("sms", "555-0100")).toBeNull();
  });
});
