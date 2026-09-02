import { accessToken, safeEqual } from "@/lib/access";
import { phase8AlertRuleEventsLive } from "@/lib/env-contract";
import { runJobWithReceipt, type JobReceiptExecution, type JobReceiptKey } from "@/lib/jobs/job-receipts";
import {
  createLiveAgentInactivityRepository,
  runAgentInactivitySweep,
} from "@/lib/notifications/agent-inactivity";

const headers = { "Cache-Control": "no-store" };
// Registered by this slice's migration. The shared receipt union is outside this task fence.
const JOB_KEY = "agent-inactivity-sweep" as JobReceiptKey;

export type AgentInactivitySweepResult = { selected: number; emitted: number };

type Dependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<AgentInactivitySweepResult>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [left, right] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(left, right);
}

export function createAgentInactivitySweepJobHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    }
    try {
      const work = () => dependencies.run();
      const result = await (dependencies.execute
        ? dependencies.execute(JOB_KEY, work, { counters: (sweep) => ({ selected: sweep.selected, emitted: sweep.emitted }) })
        : work());
      return Response.json(result, { headers });
    } catch (cause) {
      console.error(
        "/api/jobs/agent-inactivity-sweep failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Agent inactivity sweep unavailable." }, { status: 503, headers });
    }
  };
}

export const POST = createAgentInactivitySweepJobHandler({
  enabled: phase8AlertRuleEventsLive,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: () => runAgentInactivitySweep(createLiveAgentInactivityRepository()),
});

export const GET = POST;
