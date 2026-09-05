export const runtime = "nodejs";
// One generation may hold 90 s, the pipeline allows a regeneration, and moderation another 30 s.
export const maxDuration = 300;

export { POST } from "./handler";
