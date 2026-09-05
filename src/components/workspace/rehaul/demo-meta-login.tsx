"use client";

import { useEffect, useState } from "react";

import { TITLE_PANEL_TITLE_CLASS } from "@/components/kit/deck-panel";
import { Check } from "@/components/kit/icons";

/*
 * The page the sign-in window lands on, in both of its jobs.
 *
 * On a real deployment the Facebook window comes back here after the callback, with
 * `?meta=select_asset`, and the only thing this page has to do is close itself: the sheet in the
 * page underneath has been polling for the session and moves to the account choice on its own.
 *
 * On the demo tenant there is no Facebook to open, so the window lands here first, with the
 * `state` the connect route minted, and this page stands in for Facebook's permission dialog. It
 * is a rehearsal and says so on its face; it shows the same three permissions the sheet listed,
 * and its Continue sends the window through the real callback route, which completes the round
 * trip with the mock driver. Nothing about the sheet knows which of the two it is talking to.
 */

type DemoLogin = { channel: "instagram" | "messenger"; coachName: string };

export type DemoMetaLoginProps = {
  state: string | null;
  channel: string | null;
  finished: boolean;
};

const PERMISSIONS: Record<DemoLogin["channel"], readonly string[]> = {
  instagram: [
    "Access messages sent to your Instagram professional account",
    "Reply to those messages on your behalf",
    "See the name and profile photo of people who message you",
  ],
  messenger: [
    "Access messages sent to your Facebook Page",
    "Reply to those messages on your behalf",
    "See the name and profile photo of people who message you",
  ],
};

export function DemoMetaLogin({ finished, state }: DemoMetaLoginProps) {
  const [fetched, setLogin] = useState<DemoLogin | null | "loading">("loading");
  const login = state ? fetched : null;

  useEffect(() => {
    if (finished) {
      const timer = setTimeout(() => window.close(), 600);
      return () => clearTimeout(timer);
    }
    if (!state) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/channels/meta/demo-login?state=${encodeURIComponent(state)}`, { cache: "no-store" });
        const body: unknown = response.status === 200 ? await response.json() : null;
        if (!active) return;
        if (
          body && typeof body === "object"
          && ((body as DemoLogin).channel === "instagram" || (body as DemoLogin).channel === "messenger")
          && typeof (body as DemoLogin).coachName === "string"
        ) {
          setLogin({ channel: (body as DemoLogin).channel, coachName: (body as DemoLogin).coachName });
        } else {
          setLogin(null);
        }
      } catch {
        if (active) setLogin(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [finished, state]);

  if (finished) {
    return (
      <Frame>
        <p className="m-0 text-[18px] leading-[1.5] text-[var(--ink)]">Signed in. You can close this window.</p>
        <p className="m-0 mt-2 text-[15px] leading-[1.5] text-[var(--muted)]">SetterFi is updating behind it.</p>
      </Frame>
    );
  }

  if (login === "loading") {
    return (
      <Frame>
        <p className="m-0 text-[16px] text-[var(--muted)]">Opening the sign-in.</p>
      </Frame>
    );
  }

  if (!login) {
    return (
      <Frame>
        <p className="m-0 text-[18px] leading-[1.5] text-[var(--ink)]">This sign-in link has expired.</p>
        <p className="m-0 mt-2 text-[15px] leading-[1.5] text-[var(--muted)]">Close this window and press Connect again.</p>
      </Frame>
    );
  }

  const channelName = login.channel === "instagram" ? "Instagram" : "Messenger";
  const callback = `/api/channels/meta/callback?code=demo-authorization-code&state=${encodeURIComponent(state ?? "")}`;

  return (
    <Frame>
      <p
        className="m-0 mb-5 rounded-[10px] border border-[var(--warning-line)] bg-[var(--warning-wash)] px-4 py-3 text-[15px] leading-[1.5] text-[var(--warning-body)]"
        data-slot="demo-meta-login-banner"
      >
        Demo sign-in. This window stands in for Facebook. No real account is used and nothing leaves SetterFi.
      </p>
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-full bg-[var(--accent-wash-strong)] text-[16px] font-semibold text-[var(--accent-text)]">
          {initials(login.coachName)}
        </span>
        <div className="min-w-0">
          <p className="m-0 text-[16px] leading-[1.3] font-medium text-[var(--ink)]">{login.coachName}</p>
          <p className="m-0 text-[14px] leading-[1.4] text-[var(--muted)]">Signed in to Facebook</p>
        </div>
      </div>
      <h1 className={`${TITLE_PANEL_TITLE_CLASS} mt-6 text-[var(--ink)]`}>
        SetterFi is asking to connect to your {channelName === "Instagram" ? "Instagram account" : "Facebook Page"}
      </h1>
      <p className="m-0 mt-2 text-[15px] leading-[1.5] text-[var(--muted)]">
        {channelName === "Instagram" ? "reidcapitalcoaching" : "Reid Capital Coaching"}
      </p>
      <ul className="m-0 mt-5 flex list-none flex-col gap-3 p-0">
        {PERMISSIONS[login.channel].map((line) => (
          <li className="flex items-start gap-3" key={line}>
            <span className="mt-[2px] grid size-6 flex-none place-items-center rounded-[6px] border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]">
              <Check size={14} strokeWidth={3} />
            </span>
            <span className="text-[16px] leading-[1.5] text-[var(--body)]">{line}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7 flex flex-col gap-3">
        <a
          className="inline-flex h-12 w-full items-center justify-center rounded-xl [background:var(--accent-fill)] text-[16px] font-medium text-[var(--on-accent)]"
          data-slot="demo-meta-login-continue"
          href={callback}
        >
          Continue as {login.coachName.split(" ")[0]}
        </a>
        <button
          className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-[var(--line-input)] text-[16px] font-medium text-[var(--ink)]"
          onClick={() => window.close()}
          type="button"
        >
          Cancel
        </button>
      </div>
    </Frame>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-[var(--pane)] px-4 py-8 text-[var(--ink)]" data-shell-role="coach">
      <div className="mx-auto w-full max-w-[440px] rounded-[20px] border border-[var(--line)] bg-[var(--card)] px-6 py-7 sm:px-8">
        {children}
      </div>
    </main>
  );
}
