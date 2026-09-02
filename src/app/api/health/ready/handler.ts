import {
  loadDeploymentReadiness,
  type DeploymentReadiness,
} from "@/lib/operations/deployment-readiness";

const NO_STORE = { "Cache-Control": "no-store" };

export function createReadinessHandler(
  load: () => Promise<DeploymentReadiness> = loadDeploymentReadiness,
) {
  return async function readinessHandler() {
    try {
      const result = await load();
      return Response.json(result, {
        status: result.status === "ready" ? 200 : 503,
        headers: NO_STORE,
      });
    } catch (cause) {
      console.error(
        "/api/health/ready failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({
        status: "unready",
        configuration: false,
        database: false,
        automation: false,
        requiredProviders: false,
      }, { status: 503, headers: NO_STORE });
    }
  };
}

export const GET = createReadinessHandler();
