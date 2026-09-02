"use client";

import { useEffect } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { FAILURE_BODY } from "@/lib/copy/failure";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

export default function AffiliateError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AppShell
      activePath="/affiliate"
      crumbs={[{ label: "Partner" }, { label: "View interrupted" }]}
      nav={workspaceNavigationFor("affiliate")}
      role="affiliate"
    >
      <DataState
        body={`Retry the view. ${FAILURE_BODY.billing}`}
        code={error.digest ?? "AFFILIATE_SEGMENT_RENDER_FAILED"}
        kind="error"
        retry={reset}
        title="This affiliate view couldn’t finish loading."
      />
    </AppShell>
  );
}
