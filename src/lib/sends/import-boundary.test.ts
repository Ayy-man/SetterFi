/**
 * Source contract for the single physical messaging-dispatch boundary.
 *
 * Selector imports are legal because webhook verification, inbound normalization, and install
 * recovery are not outbound sends. Plan 03-07 removed the final temporary debt, so the source
 * fence now permits exactly one physical provider dispatch in provider-dispatch.ts.
 */

import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

type PermanentNonDispatchAllowance = {
  file: string;
  members: readonly string[];
  reason: string;
};

type DispatchCall = {
  file: string;
  member: "send" | "sendTemplate";
  signature: string;
  line: number;
};

const PERMANENT_NON_DISPATCH_ALLOWANCES = [
  {
    file: "src/lib/webhooks/process-inbound.ts",
    members: ["reconcileInstall"],
    reason: "INSTALL recovery reconciles credentials and never dispatches a lead message.",
  },
  {
    file: "src/app/api/webhooks/ghl/handler.ts",
    members: ["verifyWebhook", "normalizeInbound"],
    reason: "The signed GHL ingress verifies and normalizes inbound events only.",
  },
  {
    file: "src/app/api/webhooks/meta/handler.ts",
    members: ["verifyWebhook", "normalizeInbound"],
    reason: "The signed Meta ingress verifies and normalizes inbound events only.",
  },
] as const satisfies readonly PermanentNonDispatchAllowance[];

const TEMPORARY_DISPATCH_DEBTS = [] as const;

const CANONICAL_DISPATCH_FILE = "src/lib/sends/provider-dispatch.ts";

function normalized(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function memberCall(node: ts.Node): node is ts.CallExpression & {
  expression: ts.PropertyAccessExpression;
} {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === "send" || node.expression.name.text === "sendTemplate");
}

function syntheticDispatchCalls(source: string) {
  const file = ts.createSourceFile("synthetic.ts", source, ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (memberCall(node)) calls.push(node.expression.name.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function rootIdentifier(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return rootIdentifier(node.expression);
  }
  if (ts.isCallExpression(node) || ts.isParenthesizedExpression(node)) {
    return rootIdentifier(node.expression);
  }
  return null;
}

function repositoryDispatchCalls() {
  const root = process.cwd();
  const candidateFiles = ts.sys.readDirectory(
    path.join(root, "src"),
    [".ts", ".tsx"],
  ).filter((file) => !file.endsWith(".test.ts") &&
    /\.\s*(?:send|sendTemplate)\s*\(/u.test(ts.sys.readFile(file) ?? ""));
  const calls: DispatchCall[] = [];

  for (const file of candidateFiles) {
    const source = ts.sys.readFile(file);
    if (source === undefined) throw new Error("SOURCE_CONTRACT_READ_FAILED");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const relative = path.relative(root, file).split(path.sep).join("/");
    function visit(node: ts.Node) {
      if (memberCall(node)) {
        const receiver = node.expression.expression;
        // Injected `dependencies.*` calls target already-authorized application ports, not
        // provider drivers. A direct driver/adapter/selector member call is physical dispatch.
        if (rootIdentifier(receiver) !== "dependencies") {
          const member = node.expression.name.text === "send" ? "send" : "sendTemplate";
          calls.push({
            file: relative,
            member,
            signature: normalized(node.expression.getText(sourceFile)),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return calls;
}

function temporaryDebtMatches(call: DispatchCall, debt: DispatchCall) {
  return call.file === debt.file && call.member === debt.member && call.signature === debt.signature;
}

describe("outbound messaging dispatch boundary", () => {
  it("documents three permanent non-dispatch selector allowances separately from sends", () => {
    expect(PERMANENT_NON_DISPATCH_ALLOWANCES).toHaveLength(3);
    expect(PERMANENT_NON_DISPATCH_ALLOWANCES.map(({ file, members }) => ({ file, members }))).toEqual([
      { file: "src/lib/webhooks/process-inbound.ts", members: ["reconcileInstall"] },
      { file: "src/app/api/webhooks/ghl/handler.ts", members: ["verifyWebhook", "normalizeInbound"] },
      { file: "src/app/api/webhooks/meta/handler.ts", members: ["verifyWebhook", "normalizeInbound"] },
    ]);
    expect(PERMANENT_NON_DISPATCH_ALLOWANCES.every(({ reason }) => reason.length > 40)).toBe(true);
  });

  it("allows zero temporary debts and exactly one provider-dispatch call", () => {
    const calls = repositoryDispatchCalls();
    const temporary = calls.filter((call) =>
      TEMPORARY_DISPATCH_DEBTS.some((debt) => temporaryDebtMatches(call, debt))
    );
    const forbidden = calls.filter((call) =>
      call.file !== CANONICAL_DISPATCH_FILE &&
      !TEMPORARY_DISPATCH_DEBTS.some((debt) => temporaryDebtMatches(call, debt))
    );
    const staleTemporaryEntries = TEMPORARY_DISPATCH_DEBTS.filter((debt) =>
      !calls.some((call) => temporaryDebtMatches(call, debt))
    );

    expect(temporary.map(({ file, member, signature }) => ({ file, member, signature }))).toEqual(
      TEMPORARY_DISPATCH_DEBTS,
    );
    expect(staleTemporaryEntries).toEqual([]);
    expect(forbidden).toEqual([]);
    expect(TEMPORARY_DISPATCH_DEBTS).toHaveLength(0);
    expect(
      calls.filter(({ file }) => file === CANONICAL_DISPATCH_FILE),
      "PHASE3_SEND_TO_LEAD_SEAM_MISSING",
    ).toHaveLength(1);
  });

  it("detects a synthetic unlisted driver send and sendTemplate call", () => {
    expect(syntheticDispatchCalls(`
      async function violation(driver: { send(): Promise<void>; sendTemplate(): Promise<void> }) {
        await driver.send();
        await driver.sendTemplate();
      }
    `)).toEqual(["send", "sendTemplate"]);
  });
});
