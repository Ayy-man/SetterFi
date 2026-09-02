"use client";

import { useEffect } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { FAILURE_BODY } from "@/lib/copy/failure";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

export default function AdminError({
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
      activePath="/admin/overview"
      crumbs={[{ label: "Platform" }, { label: "View interrupted" }]}
      nav={workspaceNavigationFor("admin")}
      role="admin"
    >
      <DataState
        body={`Retry the view. ${FAILURE_BODY.platform}`}
        code={error.digest ?? "ADMIN_SEGMENT_RENDER_FAILED"}
        kind="error"
        retry={reset}
        title="This admin view couldn’t finish loading."
      />
    </AppShell>
  );
}
