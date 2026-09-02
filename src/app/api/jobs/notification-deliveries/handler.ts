import { randomUUID } from "node:crypto";

import { accessToken, safeEqual } from "@/lib/access";
import { phase8AlertsLive } from "@/lib/env-contract";
import { createMockEmailDriver } from "@/lib/integrations/email/mock";
import { createRealEmailDriver } from "@/lib/integrations/email/real";
import { resolveEmailDriver } from "@/lib/integrations/email/selector";
import type { EmailDriver } from "@/lib/integrations/email/types";
import { createMockSlackDriver } from "@/lib/integrations/slack/mock";
import { createRealSlackDriver } from "@/lib/integrations/slack/real";
import { resolveSlackDriver } from "@/lib/integrations/slack/selector";
import type { SlackDriver } from "@/lib/integrations/slack/types";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import {
  createLiveNotificationDeliveryRepository,
  createSlackWebhookPacer,
  deliverClaimedNotification,
  type ClaimedNotificationDelivery,
} from "@/lib/notifications/delivery";
import {
  createLiveScheduledCheckRepository,
  runScheduledAlertChecks,
} from "@/lib/notifications/scheduled-checks";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export type NotificationDeliveryJobReceipt = {
  scheduled: number;
  recovered: number;
  expired: number;
  claimed: number;
  accepted: number;
  delivered: number;
  retryable: number;
  unavailable: number;
};

type Dependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<NotificationDeliveryJobReceipt>;
};

export function createNotificationDeliveryJobHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    }
    try {
      const work = () => dependencies.run();
      return Response.json(
        await (dependencies.execute ? dependencies.execute("notification-deliveries", work) : work()),
        { headers },
      );
    } catch (cause) {
      console.error(
        "/api/jobs/notification-deliveries failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Notification delivery unavailable." }, { status: 503, headers });
    }
  };
}

const unusedEmailDriver: EmailDriver = {
  deliverEmail: async () => { throw new Error("EMAIL_DRIVER_NOT_SELECTED_FOR_SLACK_DELIVERY"); },
};
const unusedSlackDriver: SlackDriver = {
  postSlack: async () => { throw new Error("SLACK_DRIVER_NOT_SELECTED_FOR_EMAIL_DELIVERY"); },
};

type DeliveryDriverResolvers = {
  email(isDemo: boolean): EmailDriver;
  slack(isDemo: boolean): SlackDriver;
};

export function notificationDriversForClaim(
  claim: Pick<ClaimedNotificationDelivery, "destination" | "isTest">,
  resolvers: DeliveryDriverResolvers = {
    email: (isDemo) => resolveEmailDriver({
      isDemo,
      factories: { mock: createMockEmailDriver, real: createRealEmailDriver },
    }),
    slack: (isDemo) => resolveSlackDriver({
      isDemo,
      factories: { mock: createMockSlackDriver, real: createRealSlackDriver },
    }),
  },
) {
  return claim.destination === "email"
    ? { email: resolvers.email(claim.isTest), slack: unusedSlackDriver }
    : { email: unusedEmailDriver, slack: resolvers.slack(claim.isTest) };
}

export async function runLiveNotificationDeliveryJob(): Promise<NotificationDeliveryJobReceipt> {
  const now = new Date();
  const workerId = randomUUID();
  const scheduledRepository = createLiveScheduledCheckRepository();
  const repository = createLiveNotificationDeliveryRepository();
  const scheduled = await runScheduledAlertChecks(scheduledRepository, now);
  const recovered = await repository.recoverExpiredLeases(now);
  const expired = await repository.expireAccepted(now);
  const claims = await repository.claim(workerId, now);
  const receipt: NotificationDeliveryJobReceipt = {
    scheduled: scheduled.selected, recovered, expired, claimed: claims.length,
    accepted: 0, delivered: 0, retryable: 0, unavailable: 0,
  };
  const paceSlack = createSlackWebhookPacer();
  for (const claim of claims) {
    if (claim.destination === "slack") await paceSlack(claim.destinationUrl);
    const { email, slack } = notificationDriversForClaim(claim);
    const result = await deliverClaimedNotification({
      claim, workerId, repository, email, slack,
      emailFrom: process.env.SETTERFI_EMAIL_FROM?.trim() || "mock@setterfi.invalid",
      now,
    });
    receipt[result.outcome] += 1;
  }
  return receipt;
}

export const GET = createNotificationDeliveryJobHandler({
  enabled: phase8AlertsLive,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: runLiveNotificationDeliveryJob,
});
