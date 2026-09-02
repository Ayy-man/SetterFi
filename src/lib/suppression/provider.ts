import type { SuppressionProviderPort } from "@/lib/sends/contracts";

import { createLiveGhlSuppressionProviderPort } from "./ghl-provider";
import { createMetaSuppressionProviderPort } from "./meta-provider";

export function createSuppressionProviderRouter(input: {
  ghl: SuppressionProviderPort;
  meta: SuppressionProviderPort;
}): SuppressionProviderPort {
  const provider = (name: "ghl" | "meta_direct") => name === "ghl" ? input.ghl : input.meta;
  return {
    suppress: (request) => provider(request.provider).suppress(request),
    clear: (request) => provider(request.provider).clear(request),
    readBack: (request) => provider(request.provider).readBack(request),
  };
}

export function createLiveSuppressionProviderPort(): SuppressionProviderPort {
  return createSuppressionProviderRouter({
    ghl: createLiveGhlSuppressionProviderPort(),
    meta: createMetaSuppressionProviderPort(),
  });
}
