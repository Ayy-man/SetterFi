import { accessToken, safeEqual } from "@/lib/access";
import {
  DRIVER_NOT_CONFIGURED_COUNTERS,
  runJobWithReceipt,
  type JobReceiptExecution,
} from "@/lib/jobs/job-receipts";
import {
  platformSmokeCounters,
  platformSmokeErrorDetail,
  resolveDemoCoachTenant,
  resolvePlatformOwnerActor,
  runPlatformSmoke,
  type PlatformSmokeResult,
} from "@/lib/operations/smoke";

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

type Dependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  run(): Promise<PlatformSmokeResult>;
};

/**
 * The hourly smoke: every admin loader and the coach inbox read, run as the earliest platform
 * owner against the seeded demo coach tenant, with one receipt per run. A single failing check is
 * a failed receipt, so the System health page shows a broken admin page before a person opens it.
 */
export function createPlatformSmokeJobHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    if (!(await authorized(request, dependencies.secret))) return Response.json({ error: "Unauthorized." }, { status: 401, headers });
    try {
      const work = () => dependencies.run();
      const result = await (dependencies.execute ? dependencies.execute("platform-smoke", work, {
        counters: platformSmokeCounters,
        outcome: (value) => value.ok ? "succeeded" : "failed",
        errorDetail: platformSmokeErrorDetail,
      }) : work());
      if ((result as unknown) === DRIVER_NOT_CONFIGURED_COUNTERS) {
        return Response.json(result, { status: 200, headers });
      }
      return Response.json(result, { status: result.ok ? 200 : 503, headers });
    } catch (error) {
      return Response.json({
        ok: false, code: error instanceof Error && error.message.startsWith("SMOKE_") ? error.message : "PLATFORM_SMOKE_UNAVAILABLE",
      }, { status: 503, headers });
    }
  };
}

export async function runScheduledPlatformSmoke(): Promise<PlatformSmokeResult> {
  const actor = await resolvePlatformOwnerActor();
  if (!actor) throw new Error("SMOKE_OWNER_MISSING");
  const demoTenant = await resolveDemoCoachTenant();
  return runPlatformSmoke({
    actorId: actor.actorId,
    actorRole: actor.role,
    nowIso: new Date().toISOString(),
    demoTenantId: demoTenant?.id ?? null,
  });
}

export const GET = createPlatformSmokeJobHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  run: runScheduledPlatformSmoke,
});
