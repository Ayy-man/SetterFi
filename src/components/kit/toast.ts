"use client";

import { toast } from "sonner";

import { TOAST_DURATION_MS } from "./toast-preset";

export { TOASTER_PRESET } from "./toast-preset";

const UNDO_TOAST_DURATION_MS = 12_000;
const REFUSED_BODY = "Nothing changed here; retry when ready.";

export function toastSuccess(message: string, receipt?: { auditId: number }): void {
  toast.success(message, {
    duration: TOAST_DURATION_MS,
    id: receipt?.auditId,
  });
}

export function toastRefused(message: string): void {
  toast(message, {
    description: REFUSED_BODY,
    duration: TOAST_DURATION_MS,
  });
}

export function toastUndo(message: string, onUndo: () => Promise<void>): void {
  toast(message, {
    action: {
      label: "Undo",
      onClick: () => {
        void onUndo();
      },
    },
    duration: UNDO_TOAST_DURATION_MS,
  });
}
