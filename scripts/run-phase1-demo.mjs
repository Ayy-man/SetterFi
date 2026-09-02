/**
 * Credential-independent Phase 1 vertical-path runner.
 *
 * The executable arm is deliberately local and GHL-mock: a synthetic webhook cannot prove a real
 * provider signature. Real-arm evidence is collected from the provider-originated runbook steps.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

import {
  DEMO_IDS,
  DEMO_PHASE3_IDS,
  DEMO_PHASE3_VALUES,
  DEMO_VALUES,
  createDemoClient,
  resolveDemoTarget,
} from "./seed-phase1-demo.mjs";
import { resetPhase1Demo } from "./reset-phase1-demo.mjs";

const ROOT = new URL("../", import.meta.url);
const PORT = 3218;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const POLL_MS = 50;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requireSuccess(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

async function poll(label, read, timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await read();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_MS);
  }
  throw new Error(`${label}_TIMEOUT${lastError instanceof Error ? `:${lastError.message}` : ""}`);
}

async function waitForServer() {
  await poll("DEMO_SERVER_READY", async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/webhooks/ghl`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ghl-signature": "readiness-probe" },
        body: "{}",
      });
      return response.status === 401 && response.headers.get("content-type")?.includes("application/json");
    } catch {
      return false;
    }
  }, 30_000);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function assertDemoPortFree() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`DEMO_PORT_IN_USE:${PORT}`)));
    probe.listen(PORT, "127.0.0.1", () => probe.close(resolve));
  });
}

function providerEventFor(receipts, providerMessageId) {
  return receipts.find((row) =>
    row.payload?.normalized?.providerMessageId === providerMessageId
    || row.payload?.normalized?.events?.some((event) => event.providerMessageId === providerMessageId)
  ) ?? null;
}

async function postInbound({ eventId, messageId, body, providerIdentityId = DEMO_VALUES.providerIdentityId }) {
  const response = await fetch(`${BASE_URL}/api/webhooks/ghl`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ghl-signature": "mock-signature" },
    body: JSON.stringify({
      webhookId: eventId,
      locationId: DEMO_VALUES.locationId,
      contactId: providerIdentityId,
      messageId,
      messageType: "SMS",
      body,
    }),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`DEMO_INBOUND_HTTP_FAILED:${response.status}:${responseBody.slice(0, 160)}`);
  }
}

async function postMetaInbound() {
  const body = JSON.stringify({
    object: "page",
    entry: [{
      id: DEMO_VALUES.instagramAccountId,
      messaging: [{
        sender: { id: "phase4-demo-meta-instagram-lead" },
        recipient: { id: DEMO_VALUES.instagramAccountId },
        timestamp: 1_786_886_400_000,
        message: {
          mid: DEMO_VALUES.metaMessageId,
          text: "I want to continue the synthetic funding-readiness demo.",
        },
      }],
    }],
  });
  const mockSecret = createHash("sha256")
    .update("setterfi-meta-mock-signature-fixture")
    .digest("hex");
  const response = await fetch(`${BASE_URL}/api/webhooks/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", mockSecret).update(body).digest("hex")}`,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`DEMO_META_INBOUND_HTTP_FAILED:${response.status}:${(await response.text()).slice(0, 160)}`);
  }
}

async function waitForReceipt(client, providerMessageId, provider = "ghl") {
  return poll("DEMO_RECEIPT_PROCESSED", async () => {
    const rows = await requireSuccess(
      "DEMO_RECEIPT_READ_FAILED",
      client
        .from("webhook_events")
        .select("id, provider_event_id, status, error, payload")
        .eq("tenant_id", DEMO_IDS.tenant)
        .eq("provider", provider)
        .order("received_at", { ascending: false })
        .limit(20),
    );
    const receipt = providerEventFor(rows ?? [], providerMessageId);
    if (receipt?.status === "failed") throw new Error(`DEMO_RECEIPT_FAILED:${receipt.error ?? "unknown"}`);
    return receipt?.status === "processed" || receipt?.status === "skipped" ? receipt : null;
  }, 15_000);
}

async function messageCount(client, direction) {
  const result = await client
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", DEMO_IDS.tenant)
    .eq("direction", direction);
  if (result.error) throw new Error(`DEMO_MESSAGE_COUNT_FAILED:${result.error.message}`);
  return result.count ?? 0;
}

function printArmVerdicts() {
  console.log("GHL Mock: full persisted local path; no external provider behavior is proved");
  console.log("GHL Real: SKIPPED (a provider-signed webhook/install and named test resources are required)");
  if (process.env.SETTERFI_OPENROUTER_DRIVER === "real" && process.env.OPENROUTER_API_KEY?.trim()) {
    console.log("OpenRouter Real: returned provider metadata plus the persisted trace are proved by this run");
  } else {
    console.log("OpenRouter Real: SKIPPED (SETTERFI_OPENROUTER_DRIVER=real and OPENROUTER_API_KEY are required)");
  }
  console.log(
    "Meta Real: SKIPPED (SETTERFI_META_DRIVER=real, META_APP_ID, META_APP_SECRET, " +
      "META_SYSTEM_USER_TOKEN, META_WEBHOOK_VERIFY_TOKEN, SETTERFI_CREDENTIAL_ENCRYPTION_KEY, " +
      "META_WHATSAPP_SYSTEM_USER_TOKEN, META_WABA_ID, and META_WHATSAPP_PHONE_NUMBER_ID are required)",
  );
}

export async function runPhase1Demo() {
  console.log("Runbook step 3: npm run demo:run");
  if (process.env.SETTERFI_GHL_DRIVER === "real") {
    throw new Error("REAL_GHL_SYNTHETIC_WEBHOOK_REFUSED: use the provider-originated runbook arm");
  }
  if (process.env.SETTERFI_OPENROUTER_DRIVER === "real" && !process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("REAL_OPENROUTER_CONFIGURATION_INCOMPLETE:OPENROUTER_API_KEY");
  }

  await resetPhase1Demo();
  const target = resolveDemoTarget([]);
  await assertDemoPortFree();
  const logs = [];
  let server = null;
  try {
    const client = createDemoClient(target);
    await requireSuccess(
      "DEMO_BASELINE_CONVERSATION_FAILED",
      client.from("conversations").upsert({
        id: DEMO_IDS.runnerConversation,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.contact,
        channel: "sms",
        status: "agent",
        disclosure_pending: false,
      }, { onConflict: "id" }),
    );
    const suppressionPepper = randomBytes(32).toString("hex");
    const testRecipientHash = createHmac("sha256", suppressionPepper)
      .update(DEMO_VALUES.providerIdentityId, "utf8")
      .digest("hex");
    await requireSuccess(
      "DEMO_TEST_RECIPIENT_UPSERT_FAILED",
      client.from("tenant_test_recipients").upsert({
        id: DEMO_IDS.testRecipient,
        tenant_id: DEMO_IDS.tenant,
        channel: "sms",
        identifier_hash: testRecipientHash,
        identifier_last4: DEMO_VALUES.providerIdentityId.slice(-4),
        verified_at: "2026-08-17T00:00:00.000Z",
        verified_by: DEMO_IDS.coach,
      }, { onConflict: "id" }),
    );
    const phase3StopRecipientHash = createHmac("sha256", suppressionPepper)
      .update(DEMO_PHASE3_VALUES.stopNormalizedPhone, "utf8")
      .digest("hex");
    await requireSuccess(
      "PHASE3_DEMO_TEST_RECIPIENT_UPSERT_FAILED",
      client.from("tenant_test_recipients").upsert({
        id: DEMO_PHASE3_IDS.testRecipient,
        tenant_id: DEMO_IDS.tenant,
        channel: "sms",
        identifier_hash: phase3StopRecipientHash,
        identifier_last4: DEMO_PHASE3_VALUES.stopNormalizedPhone.slice(-4),
        verified_at: "2026-08-17T00:00:00.000Z",
        verified_by: DEMO_PHASE3_IDS.admin,
      }, { onConflict: "id" }),
    );
    const nextBinary = new URL("node_modules/next/dist/bin/next", ROOT);
    const cronSecret = randomBytes(32).toString("hex");
    server = spawn(process.execPath, [nextBinary.pathname, "dev", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT.pathname,
    detached: true,
    env: {
      ...process.env,
      WATCHPACK_POLLING: "true",
      NEXT_PUBLIC_SUPABASE_URL: target.url,
      SUPABASE_SERVICE_ROLE_KEY: target.serviceRoleKey,
      SETTERFI_AUTH_MODE: "supabase",
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_PHASE2_LIVE: "false",
      SETTERFI_PHASE3_LIVE: "true",
      SETTERFI_PHASE4_LIVE: "true",
      SETTERFI_GHL_DRIVER: "mock",
      SETTERFI_OPENROUTER_DRIVER: process.env.SETTERFI_OPENROUTER_DRIVER === "real" ? "real" : "mock",
      SETTERFI_META_DRIVER: "mock",
      SETTERFI_TAG_SECRET: randomBytes(32).toString("hex"),
      SETTERFI_SUPPRESSION_PEPPER: suppressionPepper,
      CRON_SECRET: cronSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
    for (const stream of [server.stdout, server.stderr]) {
      stream.on("data", (chunk) => {
        logs.push(String(chunk));
        if (logs.length > 80) logs.shift();
      });
    }

    await waitForServer();
    const firstMessageId = DEMO_VALUES.ghlInitialMessageId;
    const startedAt = new Date();
    const startedMs = Date.now();
    await postInbound({
      eventId: DEMO_VALUES.ghlInitialEventId,
      messageId: firstMessageId,
      body: "I want to understand funding readiness.",
    });
    const inbound = await poll("DEMO_INBOUND_ROW_VISIBLE", async () => {
      const data = await requireSuccess(
        "DEMO_INBOUND_READ_FAILED",
        client
          .from("messages")
          .select("id, conversation_id, tenant_id, provider_message_id")
          .eq("tenant_id", DEMO_IDS.tenant)
          .eq("provider", "ghl")
          .eq("provider_message_id", firstMessageId)
          .eq("direction", "in")
          .maybeSingle(),
      );
      return data ?? null;
    }, 5_000);
    const endedAt = new Date();
    const elapsedMs = Date.now() - startedMs;
    if (elapsedMs > 5_000) throw new Error(`DEMO_INBOUND_SLA_EXCEEDED:${elapsedMs}`);
    const firstReceipt = await waitForReceipt(client, firstMessageId);
    await poll("DEMO_INITIAL_OUTBOUND", async () => (await messageCount(client, "out")) > 0, 15_000);
    // Phase 3: prove the formerly failing outbound path persisted the message and its audit row.
    const initialOutbound = await requireSuccess(
      "PHASE3_INITIAL_OUTBOUND_READ_FAILED",
      client.from("messages").select("id,provider_message_id,state_entry_key")
        .eq("tenant_id", DEMO_IDS.tenant).eq("conversation_id", inbound.conversation_id)
        .eq("direction", "out").eq("state_entry_key", `inbound:ghl:${firstMessageId}`).single(),
    );
    const initialAudit = await requireSuccess(
      "PHASE3_INITIAL_OUTBOUND_AUDIT_READ_FAILED",
      client.from("audit_log").select("id,payload")
        .eq("tenant_id", DEMO_IDS.tenant).eq("target_id", inbound.conversation_id)
        .eq("action", "conversation.channel_continued")
        .contains("payload", { messageId: initialOutbound.id }).limit(1).single(),
    );
    if (initialAudit.payload?.providerMessageId !== initialOutbound.provider_message_id) {
      throw new Error("PHASE3_INITIAL_OUTBOUND_ATOMIC_READBACK_INVALID");
    }
    console.log(`Phase 3 initial outbound persistence: message=${initialOutbound.id} audit=${initialAudit.id}`);

    await postMetaInbound();
    const metaReceipt = await waitForReceipt(client, DEMO_VALUES.metaMessageId, "meta");
    const metaReadback = await poll("DEMO_META_PERSISTED_READBACK", async () => {
      const message = await requireSuccess(
        "DEMO_META_MESSAGE_READ_FAILED",
        client.from("messages").select("id, conversation_id, provider_message_id")
          .eq("tenant_id", DEMO_IDS.tenant)
          .eq("provider", "meta_direct")
          .eq("provider_message_id", DEMO_VALUES.metaMessageId)
          .eq("direction", "in").maybeSingle(),
      );
      if (!message) return null;
      const conversation = await requireSuccess(
        "DEMO_META_WINDOW_READ_FAILED",
        client.from("conversations").select("id, provider_window_expires_at")
          .eq("id", message.conversation_id).eq("tenant_id", DEMO_IDS.tenant).single(),
      );
      return conversation.provider_window_expires_at ? { message, conversation } : null;
    }, 15_000);
    console.log(
      `Phase 4 signed Meta Mock read-back: provider_receipt=${metaReceipt.id} ` +
        `message=${metaReadback.message.id} conversation=${metaReadback.conversation.id}`,
    );

    console.log("Runbook step 4: observe the tenant-scoped live conversation and message rows");
    await requireSuccess(
      "DEMO_QUALIFICATION_WRITE_FAILED",
      client.from("contacts").update({
        credit_range: "700+",
        funding_goal: "$50K–100K",
        timeline: "ASAP–30d",
        business_stage: "operating",
        annual_revenue_cents: 12_000_000,
        business_context: "Established demo business",
        outcome: "BOOK",
        dq_reason: null,
      }).eq("id", DEMO_IDS.contact).eq("tenant_id", DEMO_IDS.tenant),
    );
    const qualified = await requireSuccess(
      "DEMO_QUALIFICATION_READ_FAILED",
      client.from("contacts").select("credit_range, funding_goal, timeline, business_stage, outcome, is_test")
        .eq("id", DEMO_IDS.contact).eq("tenant_id", DEMO_IDS.tenant).single(),
    );
    if (qualified.outcome !== "BOOK" || qualified.is_test !== true) {
      throw new Error("DEMO_QUALIFICATION_READBACK_INVALID");
    }

    console.log("Runbook step 5: observe typed BOOK qualification on the live contact row");
    const appointmentExternalId = DEMO_VALUES.appointmentExternalId;
    const startAt = new Date(Date.now() + 24 * 60 * 60_000);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    const appointmentRows = await requireSuccess(
      "DEMO_APPOINTMENT_RPC_FAILED",
      client.rpc("record_provider_appointment", {
        p_expected_tenant: DEMO_IDS.tenant,
        p_contact_id: DEMO_IDS.contact,
        p_conversation_id: inbound.conversation_id,
        p_calendar_connection_id: DEMO_IDS.calendar,
        p_provider: "ghl",
        p_external_id: appointmentExternalId,
        p_start_at: startAt.toISOString(),
        p_end_at: endAt.toISOString(),
        p_timezone: "America/New_York",
        p_created_source: "agent",
        p_attributed_to_agent: true,
      }),
    );
    const appointmentId = appointmentRows?.[0]?.appointment_id;
    if (!appointmentId || appointmentRows[0].billable_event_id !== null) {
      throw new Error("DEMO_TEST_APPOINTMENT_BILLING_INVALID");
    }
    const appointment = await requireSuccess(
      "DEMO_APPOINTMENT_READ_FAILED",
      client.from("appointments").select("id, external_id, is_test, timezone")
        .eq("id", appointmentId).eq("tenant_id", DEMO_IDS.tenant).single(),
    );
    if (appointment.external_id !== appointmentExternalId || appointment.is_test !== true) {
      throw new Error("DEMO_APPOINTMENT_READBACK_INVALID");
    }
    const billable = await requireSuccess(
      "DEMO_BILLABLE_READ_FAILED",
      client.from("billable_events").select("id").eq("tenant_id", DEMO_IDS.tenant),
    );
    const notifications = await requireSuccess(
      "DEMO_NOTIFICATION_READ_FAILED",
      client.from("notifications").select("id").eq("tenant_id", DEMO_IDS.tenant),
    );
    if ((billable ?? []).length !== 0 || (notifications ?? []).length !== 0) {
      throw new Error("DEMO_TEST_SIDE_EFFECT_SUPPRESSION_FAILED");
    }

    console.log("Runbook step 6: observe the provider-ID test appointment and zero billing/notification rows");
    await requireSuccess(
      "DEMO_CLAIM_FAILED",
      client.rpc("claim_conversation", {
        p_expected_tenant: DEMO_IDS.tenant,
        p_conversation_id: inbound.conversation_id,
        p_actor_id: DEMO_IDS.coach,
        p_expected_status: "agent",
        p_expected_holder_id: null,
        p_confirm_displace: false,
      }),
    );
    const outboundBeforeHeld = await messageCount(client, "out");
    const heldMessageId = DEMO_VALUES.ghlHeldMessageId;
    await postInbound({
      eventId: DEMO_VALUES.ghlHeldEventId,
      messageId: heldMessageId,
      body: "I have one more question.",
    });
    await waitForReceipt(client, heldMessageId);
    const heldConversation = await requireSuccess(
      "DEMO_HELD_CONVERSATION_READ_FAILED",
      client.from("conversations").select("status, taken_over_by, unread_by_coach")
        .eq("id", inbound.conversation_id).eq("tenant_id", DEMO_IDS.tenant).single(),
    );
    if (
      heldConversation.status !== "human" || heldConversation.taken_over_by !== DEMO_IDS.coach ||
      heldConversation.unread_by_coach !== true || await messageCount(client, "out") !== outboundBeforeHeld
    ) throw new Error("DEMO_TAKEOVER_HOLD_INVALID");

    console.log("Runbook step 7: observe takeover, unread held inbound, and no agent outbound");
    await requireSuccess(
      "DEMO_RELEASE_FAILED",
      client.rpc("release_conversation", {
        p_expected_tenant: DEMO_IDS.tenant,
        p_conversation_id: inbound.conversation_id,
        p_actor_id: DEMO_IDS.coach,
        p_expected_holder_id: DEMO_IDS.coach,
      }),
    );
    const settings = await requireSuccess(
      "DEMO_DISCLOSURE_READ_FAILED",
      client.from("platform_settings").select("agent_content, approved").eq("singleton", true).single(),
    );
    if (settings.approved !== false) throw new Error("DEMO_AGENT_CONTENT_APPROVAL_MUTATED");
    const disclosure = settings.agent_content?.automatedExperienceDisclosure;
    if (typeof disclosure !== "string" || !disclosure.startsWith("[DRAFT]")) {
      throw new Error("DEMO_DISCLOSURE_DRAFT_REQUIRED");
    }
    const resumedMessageId = DEMO_VALUES.ghlResumedMessageId;
    await postInbound({
      eventId: DEMO_VALUES.ghlResumedEventId,
      messageId: resumedMessageId,
      body: "Please continue.",
    });
    await waitForReceipt(client, resumedMessageId);
    const resumedOutbound = await poll("DEMO_DISCLOSURE_OUTBOUND", async () => {
      const rows = await requireSuccess(
        "DEMO_OUTBOUND_READ_FAILED",
        client.from("messages").select("id, body, provider_message_id")
          .eq("tenant_id", DEMO_IDS.tenant).eq("conversation_id", inbound.conversation_id)
          .eq("direction", "out").order("created_at", { ascending: false }).limit(1),
      );
      return rows?.[0]?.body?.startsWith(disclosure) ? rows[0] : null;
    }, 15_000);
    // Phase 3: the outbound row can become visible just before its trace on the local stack.
    await poll("PHASE3_DEMO_TRACE_PERSISTENCE", async () => {
      const rows = await requireSuccess(
        "PHASE3_DEMO_TRACE_PERSISTENCE_READ_FAILED",
        client.from("message_traces").select("message_id").eq("tenant_id", DEMO_IDS.tenant),
      );
      return rows.length >= 2 ? rows : null;
    }, 15_000);
    const finalConversation = await requireSuccess(
      "DEMO_FINAL_CONVERSATION_READ_FAILED",
      client.from("conversations").select("status, taken_over_by, disclosure_pending")
        .eq("id", inbound.conversation_id).eq("tenant_id", DEMO_IDS.tenant).single(),
    );
    const traces = await requireSuccess(
      "DEMO_TRACE_READ_FAILED",
      client.from("message_traces").select("message_id, model, moderator_state, trace")
        .eq("tenant_id", DEMO_IDS.tenant),
    );
    if (
      finalConversation.status !== "agent" || finalConversation.taken_over_by !== null ||
      finalConversation.disclosure_pending !== false || !resumedOutbound.id || (traces ?? []).length < 2
    ) throw new Error("DEMO_FINAL_READBACK_INVALID");

    console.log("Runbook step 8: observe handback, one-time disclosure, trace, and final persisted state");
    console.log("Runbook step 9: observe the managed local development server is running");
    console.log("Runbook step 10: invoke the CRON_SECRET-protected reconciliation fallback");
    const cronResponse = await fetch(`${BASE_URL}/api/jobs/appointment-reconcile`, {
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    if (!cronResponse.ok) throw new Error(`DEMO_CRON_FALLBACK_FAILED:${cronResponse.status}`);
    const cronReadback = await cronResponse.json();
    if (
      typeof cronReadback !== "object" || cronReadback === null ||
      !["connections", "checked", "canceled"].every((key) => Number.isInteger(cronReadback[key]))
    ) throw new Error("DEMO_CRON_FALLBACK_READBACK_INVALID");
    console.log("Runbook step 11: observe the successful reconciliation response and persisted read-back");
    const stopOutboundBefore = await messageCount(client, "out");
    await postInbound({
      eventId: DEMO_PHASE3_VALUES.stopEventId,
      messageId: DEMO_PHASE3_VALUES.stopMessageId,
      body: "STOP",
      providerIdentityId: DEMO_PHASE3_VALUES.stopProviderIdentityId,
    });
    await waitForReceipt(client, DEMO_PHASE3_VALUES.stopMessageId);
    const stopContact = await requireSuccess(
      "PHASE3_DEMO_STOP_READBACK_FAILED",
      client.from("contacts")
        .select("opted_out,stop_confirmation_key,stop_confirmation_reserved_at,stop_confirmation_sent_at,is_test")
        .eq("tenant_id", DEMO_IDS.tenant).eq("id", DEMO_PHASE3_IDS.contacts[0]).single(),
    );
    if (
      stopContact.opted_out !== true || stopContact.is_test !== true ||
      !stopContact.stop_confirmation_key || !stopContact.stop_confirmation_reserved_at ||
      stopContact.stop_confirmation_sent_at !== null ||
      await messageCount(client, "out") !== stopOutboundBefore
    ) throw new Error("PHASE3_DEMO_STOP_COPY_BLOCK_INVALID");
    console.log("STOP confirmation refused — copy_unapproved; outbound_delta=0; client wording remains pending");
    const evidence = {
      start: startedAt.toISOString(),
      end: endedAt.toISOString(),
      elapsedMs,
      tenant: DEMO_IDS.tenant,
      providerEventId: firstReceipt.provider_event_id,
      messageRowId: inbound.id,
      metaProviderEventId: metaReceipt.provider_event_id,
      metaMessageRowId: metaReadback.message.id,
    };
    console.log(`CRITERION_1_EVIDENCE=${JSON.stringify(evidence)}`);
    console.log(`Demo path complete: appointment=${appointmentId} trace_rows=${traces.length}`);
    printArmVerdicts();
    return { evidence, appointmentId, traceCount: traces.length };
  } catch (error) {
    const detail = logs.join("").split("\n").slice(-20).join("\n");
    if (detail) console.error(`Demo server tail:\n${detail}`);
    throw error;
  } finally {
    if (server) await stopServer(server);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhase1Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "DEMO_RUN_FAILED");
    process.exitCode = 1;
  });
}
