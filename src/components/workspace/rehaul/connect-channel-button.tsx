"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { ConnectChannelSheet, type ConnectChannelSheetProps } from "@/components/workspace/rehaul/connect-channel-sheet";
import { RETURN_QUERY, type ConnectChannel } from "@/components/workspace/rehaul/connect-channel-flow";

/**
 * The button that opens the connect sheet, and the one place that reads the callback's query.
 *
 * Every "Connect" and "Reconnect" for Instagram and Messenger renders this, on Home, on Setup and
 * on the onboarding step, so the flow is the same sheet wherever it was pressed. When the browser
 * blocked the sign-in window and the sign-in ran in this tab instead, the callback lands back on
 * the page with `?meta=select_asset`; the button sees that on mount, opens the sheet straight at
 * the account choice, and clears the query so a refresh does not reopen it.
 */
export type ConnectChannelButtonProps = {
  channels: readonly ConnectChannel[];
  availability?: ConnectChannelSheetProps["availability"];
  className: string;
  children: ReactNode;
  disabled?: boolean;
};

export function ConnectChannelButton({ availability, channels, children, className, disabled }: ConnectChannelButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resume, setResume] = useState<ConnectChannelSheetProps["resume"]>(null);
  const [mountKey, setMountKey] = useState(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get(RETURN_QUERY.key);
    if (value !== RETURN_QUERY.chooseValue && value !== RETURN_QUERY.errorValue) return;
    url.searchParams.delete(RETURN_QUERY.key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // The URL is the external system here; the sheet reopens on the next frame so the return
    // from Meta is not a state write inside the effect body.
    const frame = window.requestAnimationFrame(() => {
      setResume(value === RETURN_QUERY.chooseValue ? "choose" : "error");
      setMountKey((key) => key + 1);
      setOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <button
        className={className}
        data-slot="connect-channel-button"
        disabled={disabled}
        onClick={() => {
          setResume(null);
          setMountKey((key) => key + 1);
          setOpen(true);
        }}
        type="button"
      >
        {children}
      </button>
      {open ? (
        <ConnectChannelSheet
          availability={availability}
          channels={channels}
          key={mountKey}
          onConnected={() => router.refresh()}
          onOpenChange={setOpen}
          open={open}
          resume={resume}
        />
      ) : null}
    </>
  );
}
