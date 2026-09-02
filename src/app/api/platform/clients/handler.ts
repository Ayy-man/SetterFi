/** Success client book projection; My/All changes only the query filter. */

import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import {
  createSupportRepository,
  type SuccessClientBookRead,
  type SupportBook,
} from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";

const noStoreHeaders = { "Cache-Control": "no-store" };

type ClientBookDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  list(session: SupportSession, book: SupportBook): Promise<SuccessClientBookRead[]>;
};

export function createClientBookHandler(dependencies: ClientBookDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return Response.json(
      { error: "Not found." },
      { status: 404, headers: noStoreHeaders },
    );
    const session = await dependencies.session();
    if (!session) return Response.json(
      { error: "Authentication required." },
      { status: 401, headers: noStoreHeaders },
    );
    if (hasImpersonationMarker(session) || !["owner", "admin", "success"].includes(session.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== "book")) return Response.json(
      { error: "Client book selector is invalid." },
      { status: 400, headers: noStoreHeaders },
    );
    const book = params.get("book") ?? "mine";
    if (!["mine", "all"].includes(book)) return Response.json(
      { error: "Client book selector is invalid." },
      { status: 400, headers: noStoreHeaders },
    );
    try {
      return Response.json({ clients: await dependencies.list(session, book as SupportBook) }, {
        headers: noStoreHeaders,
      });
    } catch (cause) {
      console.error(
        "/api/platform/clients failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { error: "Client book is temporarily unavailable." },
        { status: 503, headers: noStoreHeaders },
      );
    }
  };
}

const repository = createSupportRepository();
const service = createSupportService(repository);

export const GET = createClientBookHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  list: (session, book) => service.listClientBook(session, book),
});
