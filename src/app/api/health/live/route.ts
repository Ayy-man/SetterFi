const NO_STORE = { "Cache-Control": "no-store" };

/** Process liveness deliberately performs no configuration, database, or provider work. */
export async function GET() {
  return Response.json({ status: "alive" }, { headers: NO_STORE });
}
