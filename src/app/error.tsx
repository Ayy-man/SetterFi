"use client";

import { useEffect } from "react";

import { FAILURE_BODY } from "@/lib/copy/failure";

export default function GlobalError({
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
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-foreground">
      <section className="w-full max-w-md rounded-xl border bg-card p-8 text-center">
        <p className="font-mono text-xs tracking-[0.12em] text-destructive uppercase">
          Workspace interrupted
        </p>
        <h1 className="mt-3 text-2xl font-medium">This surface couldn’t finish loading.</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Retry the view. {FAILURE_BODY.platform}
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Retry view
        </button>
      </section>
    </main>
  );
}
