import type { ReactNode } from "react";

import {
  ImpersonationBanner,
  type ImpersonationBannerProps,
} from "@/components/kit/impersonation-banner";

/**
 * The band, and the room it needs, wrapped around every workspace route.
 *
 * The canvas draws the impersonation band as a full-width strip across the very top of the page,
 * above the rail as well as the topbar, which is why this sits in `(workspace)/layout.tsx` rather
 * than inside `AppShell`: the layout is the only server boundary above all thirty shell mounts, so
 * one read there puts the band on every page of a session instead of on the pages somebody
 * remembered.
 *
 * ## The height rules, and why they only exist while a session is open
 *
 * `AppShell` sizes itself against the viewport -- `min-h-svh` on the shell root, and `h-svh` on the
 * content column for the pages that declare `data-layout="fixed"` and manage their own scrolling.
 * Both are correct when the shell is the whole page. Put a band above it and each one overshoots by
 * exactly the band's height, which on a fixed-layout page means the inbox's own scroller hangs off
 * the bottom of the window.
 *
 * So while a session is open the frame becomes the thing measured against the viewport and the
 * shell is told to fill what is left. The rules are unlayered, so they outrank the Tailwind
 * utilities they correct without a specificity game, and they are gated on `data-impersonating`,
 * so a normal session renders no wrapper behaviour at all -- the frame is a bare fragment-shaped
 * div and every viewport rule inside the shell is untouched.
 */
const FRAME_STYLES = `
[data-workspace-frame="impersonating"] {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
[data-workspace-frame="impersonating"] > [data-slot="impersonation-banner"] {
  flex: 0 0 auto;
}
[data-workspace-frame="impersonating"] [data-shell-root] {
  min-height: 0;
  flex: 1 1 auto;
}
[data-workspace-frame="impersonating"] [data-shell-root] #content {
  height: auto;
  min-height: 0;
}
`;

export type ImpersonationFrameProps = {
  /** The live session, or null on every ordinary page load. */
  session: ImpersonationBannerProps | null;
  children: ReactNode;
};

export function ImpersonationFrame({ children, session }: ImpersonationFrameProps) {
  if (!session) return <>{children}</>;

  return (
    <div data-workspace-frame="impersonating">
      <style dangerouslySetInnerHTML={{ __html: FRAME_STYLES }} />
      <ImpersonationBanner {...session} />
      {children}
    </div>
  );
}
