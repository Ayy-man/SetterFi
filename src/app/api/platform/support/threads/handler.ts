/** Platform support listing with My/All as a query filter, never an authorization claim. */

import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import {
  createSupportRepository,
  SUPPORT_STATUSES,
  type PlatformSupportThreadRead,
  type SupportBook,
  type SupportStatus,
} from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";

const noStoreHeaders = { "Cache-Control": "no-store" };

type PlatformThreadsDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  list(
    session: SupportSession,
    input: { book: SupportBook; status?: SupportStatus },
  ): Promise<PlatformSupportThreadRead[]>;
};

export function createPlatformThreadsHandler(dependencies: PlatformThreadsDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const session = await dependencies.session();
    if (!session) return Response.json(
      { error: "Authentication required." },
      { status: 401, headers: noStoreHeaders },
    );
    if (hasImpersonationMarker(session) || !["owner", "admin", "success"].includes(session.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !["book", "status"].includes(key))) {
      return Response.json(
        { error: "Support selectors are invalid." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const book = params.get("book") ?? "mine";
    const status = params.get("status");
    if (!["mine", "all"].includes(book)
      || (status !== null && !SUPPORT_STATUSES.includes(status as SupportStatus))) {
      return Response.json(
        { error: "Support selectors are invalid." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    try {
      const threads = await dependencies.list(session, {
        book: book as SupportBook,
        ...(status ? { status: status as SupportStatus } : {}),
      });
      return Response.json({ threads }, { headers: noStoreHeaders });
    } catch (cause) {
      console.error(
        "/api/platform/support/threads failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { error: "Support threads are temporarily unavailable." },
        { status: 503, headers: noStoreHeaders },
      );
    }
  };
}

const repository = createSupportRepository();
const service = createSupportService(repository);

export const GET = createPlatformThreadsHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  list: (session, input) => service.listPlatformThreads(session, input),
});
