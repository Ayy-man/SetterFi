import { GET as handleGET } from "./handler";

export async function GET(request: Request) {
  return handleGET(request);
}
