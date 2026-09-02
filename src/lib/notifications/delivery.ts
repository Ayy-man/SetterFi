/** Durable queue delivery: every call starts from a claimed attempt and ends through the finish RPC. */

import type { EmailDriver } from "@/lib/integrations/email/types";
import type { SlackDriver } from "@/lib/integrations/slack/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  5 * 60 * 60_000,
] as const;
export const ACCEPTED_RECEIPT_TIMEOUT_MS = 24 * 60 * 60_000;

export type ClaimedNotificationDelivery = {
  deliveryId: string;
  notificationId: string;
  attemptId: string;
  attemptNumber: number;
  destination: "email" | "slack";
  tenantId: string | null;
  userId: string | null;
  recipientEmail: string | null;
  destinationUrl: string | null;
  eventKey: string;
  title: string;
  body: string;
  link: string | null;
  isTest: boolean;
};

export type NotificationDeliveryCopy = {
  emailSubject: string | null;
  emailBody: string | null;
  slackText: string | null;
};

export type FinishNotificationDelivery = {
  workerId: string;
  deliveryId: string;
  attemptNumber: number;
  outcome: "accepted" | "delivered" | "retryable" | "failed" | "unavailable";
  providerReference: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  retryAt: string | null;
  now: string;
};

export type NotificationDeliveryRepository = {
  loadCopy(notificationId: string): Promise<NotificationDeliveryCopy>;
  finish(input: FinishNotificationDelivery): Promise<void>;
};

export function retryAtForAttempt(
  attemptNumber: number,
  now: Date,
  providerRetryAfterSeconds: number | null,
) {
  const delay = NOTIFICATION_RETRY_DELAYS_MS[attemptNumber - 1];
  if (delay === undefined) return null;
  const providerDelay = providerRetryAfterSeconds === null
    ? 0 : Math.max(0, providerRetryAfterSeconds * 1_000);
  return new Date(now.getTime() + Math.max(delay, providerDelay)).toISOString();
}

export function recoveryForExpiredLease(attemptNumber: number, now: Date) {
  const retryAt = retryAtForAttempt(attemptNumber, now, null);
  return retryAt
    ? { status: "failed" as const, attemptOutcome: "retryable" as const, retryAt }
    : { status: "unavailable" as const, attemptOutcome: "unavailable" as const, retryAt: null };
}

export function acceptedReceiptExpired(lastAttemptAt: string, now: Date) {
  return now.getTime() - Date.parse(lastAttemptAt) >= ACCEPTED_RECEIPT_TIMEOUT_MS;
}

export async function deliverClaimedNotification(input: {
  claim: ClaimedNotificationDelivery;
  workerId: string;
  repository: NotificationDeliveryRepository;
  email: EmailDriver;
  slack: SlackDriver;
  emailFrom: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const finish = (values: Omit<FinishNotificationDelivery, "workerId" | "deliveryId" | "attemptNumber" | "now">) =>
    input.repository.finish({
      workerId: input.workerId,
      deliveryId: input.claim.deliveryId,
      attemptNumber: input.claim.attemptNumber,
      now: now.toISOString(),
      ...values,
    });

  // Defense in depth: test/demo facts should only create bell intents and never reach a driver.
  if (input.claim.isTest) {
    await finish({
      outcome: "unavailable", providerReference: null, errorCode: "TEST_DELIVERY_BLOCKED",
      errorDetail: "Test notifications cannot leave the bell sink.", retryAt: null,
    });
    return { outcome: "unavailable" as const };
  }

  const copy = await input.repository.loadCopy(input.claim.notificationId);
  if (input.claim.destination === "email") {
    if (!input.claim.recipientEmail || !copy.emailSubject || !copy.emailBody) {
      await finish({
        outcome: "unavailable", providerReference: null, errorCode: "EMAIL_DELIVERY_TARGET_MISSING",
        errorDetail: "Email target or copy is unavailable.", retryAt: null,
      });
      return { outcome: "unavailable" as const };
    }
    const outcome = await input.email.deliverEmail({
      deliveryId: input.claim.deliveryId,
      attemptNumber: input.claim.attemptNumber,
      to: input.claim.recipientEmail,
      from: input.emailFrom,
      subject: copy.emailSubject,
      text: copy.emailBody,
    });
    if (outcome.kind === "accepted") {
      await finish({
        outcome: "accepted", providerReference: outcome.providerReference,
        errorCode: null, errorDetail: null, retryAt: null,
      });
      return { outcome: "accepted" as const };
    }
    if (outcome.kind === "retry") {
      const retryAt = retryAtForAttempt(input.claim.attemptNumber, now, outcome.retryAfterSeconds);
      await finish({
        outcome: retryAt ? "retryable" : "unavailable", providerReference: null,
        errorCode: outcome.errorCode, errorDetail: null, retryAt,
      });
      return { outcome: retryAt ? "retryable" as const : "unavailable" as const };
    }
    await finish({
      outcome: "unavailable", providerReference: null, errorCode: outcome.errorCode,
      errorDetail: outcome.safeDetail, retryAt: null,
    });
    return { outcome: "unavailable" as const };
  }

  if (!copy.slackText) {
    await finish({
      outcome: "unavailable", providerReference: null, errorCode: "SLACK_COPY_MISSING",
      errorDetail: "Slack copy is unavailable.", retryAt: null,
    });
    return { outcome: "unavailable" as const };
  }
  const outcome = await input.slack.postSlack({
    deliveryId: input.claim.deliveryId,
    attemptNumber: input.claim.attemptNumber,
    text: copy.slackText,
    destinationUrl: input.claim.destinationUrl,
  });
  if (outcome.kind === "delivered") {
    await finish({
      outcome: "delivered", providerReference: outcome.providerReference,
      errorCode: null, errorDetail: null, retryAt: null,
    });
    return { outcome: "delivered" as const };
  }
  if (outcome.kind === "retry") {
    const retryAt = retryAtForAttempt(input.claim.attemptNumber, now, outcome.retryAfterSeconds);
    await finish({
      outcome: retryAt ? "retryable" : "unavailable", providerReference: null,
      errorCode: outcome.errorCode, errorDetail: null, retryAt,
    });
    return { outcome: retryAt ? "retryable" as const : "unavailable" as const };
  }
  await finish({
    outcome: "unavailable", providerReference: null, errorCode: outcome.errorCode,
    errorDetail: outcome.safeDetail, retryAt: null,
  });
  return { outcome: "unavailable" as const };
}

export function createLiveNotificationDeliveryRepository(): NotificationDeliveryRepository & {
  recoverExpiredLeases(now: Date): Promise<number>;
  expireAccepted(now: Date): Promise<number>;
  claim(workerId: string, now: Date): Promise<ClaimedNotificationDelivery[]>;
} {
  const client = createSupabaseServiceClient();
  return {
    loadCopy: async (notificationId) => {
      const { data, error } = await client.from("notifications")
        .select("rule:alert_rules!inner(email_subject,email_body,slack_text)")
        .eq("id", notificationId).single();
      if (error || !data) throw new Error("NOTIFICATION_COPY_READ_FAILED");
      const rule = data.rule as unknown as { email_subject: string | null; email_body: string | null; slack_text: string | null };
      return { emailSubject: rule.email_subject, emailBody: rule.email_body, slackText: rule.slack_text };
    },
    finish: async (input) => {
      const { error } = await client.rpc("finish_notification_delivery_attempt", {
        p_worker_id: input.workerId,
        p_delivery_id: input.deliveryId,
        p_attempt_number: input.attemptNumber,
        p_outcome: input.outcome,
        p_provider_reference: input.providerReference,
        p_error_code: input.errorCode,
        p_error_detail: input.errorDetail,
        p_retry_at: input.retryAt,
        p_now: input.now,
      });
      if (error) throw new Error("NOTIFICATION_DELIVERY_FINISH_FAILED");
    },
    recoverExpiredLeases: async (now) => {
      const { data, error } = await client.from("notification_deliveries")
        .select("id,attempts,lease_token").eq("status", "sending").lte("lease_expires_at", now.toISOString()).limit(25);
      if (error) throw new Error("NOTIFICATION_LEASE_READ_FAILED");
      let recovered = 0;
      for (const delivery of data ?? []) {
        const recovery = recoveryForExpiredLease(delivery.attempts, now);
        const attempt = await client.from("notification_delivery_attempts").update({
          finished_at: now.toISOString(), outcome: recovery.attemptOutcome,
          error_code: "NOTIFICATION_WORKER_LEASE_EXPIRED", error_detail: "The delivery worker lease expired.",
        }).eq("delivery_id", delivery.id).eq("attempt_number", delivery.attempts)
          .is("finished_at", null).select("id").maybeSingle();
        if (attempt.error) throw new Error("NOTIFICATION_LEASE_ATTEMPT_RECOVERY_FAILED");
        if (!attempt.data) continue;
        const aggregate = await client.from("notification_deliveries").update(recovery.retryAt ? {
          status: recovery.status, next_attempt_at: recovery.retryAt, lease_token: null, lease_expires_at: null,
          last_error_code: "NOTIFICATION_WORKER_LEASE_EXPIRED", error: "The delivery worker lease expired.",
        } : {
          status: "unavailable", next_attempt_at: null, terminal_at: now.toISOString(),
          lease_token: null, lease_expires_at: null,
          last_error_code: "NOTIFICATION_WORKER_LEASE_EXPIRED", error: "The delivery worker lease expired.",
        }).eq("id", delivery.id).eq("status", "sending").eq("lease_token", delivery.lease_token);
        if (aggregate.error) throw new Error("NOTIFICATION_LEASE_RECOVERY_FAILED");
        recovered += 1;
      }
      return recovered;
    },
    expireAccepted: async (now) => {
      const cutoff = new Date(now.getTime() - ACCEPTED_RECEIPT_TIMEOUT_MS).toISOString();
      const { data, error } = await client.from("notification_deliveries").update({
        status: "unavailable", terminal_at: now.toISOString(), next_attempt_at: null,
        last_error_code: "EMAIL_DELIVERY_RECEIPT_TIMEOUT", error: "No signed delivery receipt arrived before the acceptance timeout.",
      }).eq("status", "accepted").lte("last_attempt_at", cutoff).select("id");
      if (error) throw new Error("NOTIFICATION_ACCEPTED_TIMEOUT_FAILED");
      return data?.length ?? 0;
    },
    claim: async (workerId, now) => {
      const { data, error } = await client.rpc("claim_notification_deliveries", {
        p_worker_id: workerId, p_limit: 25, p_lease_seconds: 300, p_now: now.toISOString(),
      });
      if (error) throw new Error("NOTIFICATION_DELIVERY_CLAIM_FAILED");
      return (data ?? []).map((row: Record<string, unknown>) => ({
        deliveryId: String(row.delivery_id), notificationId: String(row.notification_id), attemptId: String(row.attempt_id),
        attemptNumber: Number(row.attempt_number), destination: row.destination as "email" | "slack",
        tenantId: row.tenant_id === null ? null : String(row.tenant_id),
        userId: row.user_id === null ? null : String(row.user_id),
        recipientEmail: row.recipient_email === null ? null : String(row.recipient_email),
        destinationUrl: row.destination_url === null ? null : String(row.destination_url),
        eventKey: String(row.event_key), title: String(row.title), body: String(row.body),
        link: row.link === null ? null : String(row.link), isTest: Boolean(row.is_test),
      }));
    },
  };
}

export function createSlackWebhookPacer(input: {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const lastByWebhook = new Map<string, number>();
  return async (destinationUrl: string | null) => {
    if (!destinationUrl) return;
    const last = lastByWebhook.get(destinationUrl);
    if (last !== undefined) await sleep(Math.max(0, 1_000 - (now() - last)));
    lastByWebhook.set(destinationUrl, now());
  };
}
