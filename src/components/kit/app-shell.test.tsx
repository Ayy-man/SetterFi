import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell, type NavGroup } from "@/components/kit/app-shell";
import { MobileAppSidebar } from "@/components/kit/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceEnvProvider } from "@/components/workspace/workspace-env";
import { demoViewTargets, workspaceNavigationFor } from "@/lib/workspace-navigation";

const nav: readonly NavGroup[] = [
  {
    label: "",
    items: [{ label: "Overview", href: "/admin/overview" }],
  },
  {
    label: "Platform",
    items: [
      { label: "Inbox", href: "/admin/inbox", count: 3 },
      {
        label: "Settings",
        href: "/admin/settings",
        children: [
          { label: "Notifications", href: "/admin/settings/notifications" },
        ],
      },
    ],
  },
  {
    label: "Brain",
    items: [{ label: "The Brain", href: "/admin/brain" }],
  },
];

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  Reflect.deleteProperty(window, "localStorage");
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.workspaceTheme;
});

function renderShell() {
  return render(
    <AppShell
      activePath="/admin/overview"
      crumbs={[
        { label: "Platform", href: "/admin" },
        { label: "Overview" },
      ]}
      nav={nav}
      role="admin"
    >
      <h1>Overview</h1>
    </AppShell>,
  );
}

/**
 * The affiliate portal is the one role whose account chip still opens the dropdown: the coach and
 * the owner get the account sheet instead, and the owner panel carries the terms registry and the
 * operator runbooks an affiliate must not be handed. So every assertion about the dropdown itself
 * -- the theme radios, the sign-out form, the demo modes' way out -- is made here.
 */
function renderAffiliateShell(mode: "open" | "supabase" = "open") {
  return render(
    <WorkspaceEnvProvider
      demoAccountSwitching={false}
      demoViews={demoViewTargets}
      mode={mode}
    >
      <AppShell activePath="/affiliate" crumbs={[{ label: "Partner earnings" }]} role="affiliate">
        <h1>Partner earnings</h1>
      </AppShell>
    </WorkspaceEnvProvider>,
  );
}

describe("AppShell elevation", () => {
  it("draws the sidebar scroll boundary as a rule, not a borrowed overlay shadow", () => {
    // The two shims were using --shadow-raised for its 24px blur alone, on a 1px line that
    // nothing sits above. An overlay token spent as a gradient is exactly how "raised" stops
    // meaning "temporarily over your work" and starts meaning "somewhere there is a soft edge".
    renderShell();

    const shims = document.querySelectorAll(
      'nav[aria-label="Primary"] > div[aria-hidden]',
    );

    expect(shims).toHaveLength(2);
    for (const shim of shims) {
      expect(shim.className).not.toContain("shadow-");
      expect(shim).toHaveClass("h-px", "bg-[var(--line)]");
    }
  });

  it("keeps the skip link elevated, because a focused skip link really is over the page", () => {
    // The one thing on this sweep that earns its shadow: it is fixed, it appears on focus, it
    // covers whatever it lands on, and it leaves the moment focus does. That is the definition
    // the rung exists for, so it stays.
    renderShell();

    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveClass(
      "bg-[var(--raised)]",
      "shadow-[var(--shadow-raised)]",
      "focus:fixed",
    );
  });
});

describe("AppShell", () => {
  it("renders the shell without a Base UI semantics warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    renderShell();

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("accepts a single crumb for a page that sits in no group", () => {
    render(
      <AppShell activePath="/admin/overview" crumbs={[{ label: "Overview" }]} nav={nav} role="admin">
        <h1>Overview</h1>
      </AppShell>,
    );

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getAllByRole("listitem")).toHaveLength(1);
  });

  it("renders a real breadcrumb whose final item is current and not linked", () => {
    renderShell();

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const list = within(breadcrumb).getByRole("list");
    const items = within(list).getAllByRole("listitem");
    const lastItem = items.at(-1);

    expect(lastItem).toBeDefined();
    expect(within(lastItem!).queryByRole("link")).not.toBeInTheDocument();
    expect(within(lastItem!).getByText("Overview")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks the active navigation item with a quiet fill and weight 500 only", () => {
    renderShell();

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    const activeItem = screen.getByRole("link", { name: "Overview" });
    expect(activeItem).toHaveAttribute("aria-current", "page");
    // The fill is a single element that glides between items as the route changes, so what makes
    // an item current is that it owns that element -- now the quiet surface, not an accent wash.
    const wash = activeItem.querySelector('[data-slot="sidebar-active-pill"]');
    expect(wash).not.toBeNull();
    expect(wash).toHaveClass("bg-[var(--quiet)]");
    // Weight 500 and ordinary ink: the fill alone says which row you are on.
    expect(activeItem).toHaveClass("data-active:font-medium");
    expect(activeItem).toHaveClass("data-active:text-[var(--ink)]");
  });

  it("gives the active row no edge treatment of any kind", () => {
    renderShell();

    const activeItem = screen.getByRole("link", { name: "Overview" });
    const wash = activeItem.querySelector('[data-slot="sidebar-active-pill"]');
    // A coloured left edge is the giveaway the client rejected by name. Every class on the row and
    // on its fill has to be free of one, in any of the shapes Tailwind can spell it.
    const edge = /(^|:)(border-l|border-s|border-r|shadow-\[inset)/u;
    for (const token of [
      ...activeItem.className.split(/\s+/u),
      ...(wash?.className ?? "").split(/\s+/u),
    ]) {
      expect(edge.test(token)).toBe(false);
    }
    // And the fill really is a fill: it covers the row rather than sitting along one side of it.
    expect(wash).toHaveClass("inset-0");
  });

  it("hovers a nav row with the same quiet fill", () => {
    renderShell();

    expect(screen.getByRole("link", { name: "The Brain" })).toHaveClass(
      "hover:bg-[var(--quiet)]",
    );
  });

  it("renders the wordmark rather than a logo tile", () => {
    const { container } = renderShell();

    expect(screen.getByRole("link", { name: "SetterFi" })).toHaveAttribute("href", "/");
    expect(container.querySelector('[data-slot="sidebar-header"]')).not.toHaveTextContent(
      /^S$/u,
    );
  });

  it("sets the wordmark's Fi in the accent's readable-as-text value", () => {
    renderShell();

    // --accent is the fill, calibrated so white sits on it at 4.6:1; as 16px text on the sidebar's
    // own ground it is 4.0:1 and fails AA. --accent-text is the same hue held darker for exactly
    // this, and the wordmark is text.
    const wordmark = screen.getByRole("link", { name: "SetterFi" });
    expect(within(wordmark).getByText("Fi")).toHaveClass("text-[var(--accent-text)]");
  });

  it("opens the command palette from the wordmark's shortcut hint", () => {
    renderShell();

    const hint = screen.getByRole("button", { name: "Open command palette" });
    expect(hint).toHaveTextContent("⌘K");

    fireEvent.click(hint);

    // The shell mounts the kit's palette now, not a second search dialog of its own, so the
    // dialog it opens is named for the role whose destinations it is gating.
    expect(screen.getByRole("dialog", { name: /command palette/iu })).toBeInTheDocument();
  });

  it("renders no icons inside the primary navigation", () => {
    renderShell();

    const primaryNavigation = screen.getByRole("navigation", { name: "Primary" });
    const menu = primaryNavigation.querySelectorAll('[data-slot="sidebar-menu"] svg');
    expect(menu).toHaveLength(0);
  });

  it("sets each group eyebrow in letterspaced uppercase at 10.5px and 600", () => {
    renderShell();

    const eyebrow = screen.getByRole("button", { name: "Platform" });
    expect(eyebrow).toHaveAttribute("data-nav-eyebrow");
    expect(eyebrow.style.fontSize).toBe("10.5px");
    expect(eyebrow.style.fontWeight).toBe("600");
    expect(eyebrow.style.textTransform).toBe("uppercase");
    expect(eyebrow.style.letterSpacing).toBe("0.08em");
    expect(eyebrow).toHaveClass("text-[var(--faint)]");
  });

  it("renders a nav count as faint right-aligned mono, and only where there is one", () => {
    renderShell();

    const inbox = screen.getByRole("link", { name: "Inbox" });
    const counts = screen
      .getByRole("navigation", { name: "Primary" })
      .querySelectorAll('[data-slot="nav-count"]');
    expect(counts).toHaveLength(1);
    const count = counts[0]!;
    expect(count).toHaveTextContent("3");
    expect(count).toHaveClass("font-mono");
    expect(count).toHaveClass("text-right");
    expect(count).toHaveClass("text-[var(--faint)]");
    expect(count).toHaveClass("text-[length:var(--t-mono-crumb)]");
    // The count belongs to the row it qualifies, not to the group.
    expect(inbox.parentElement).toContainElement(count as HTMLElement);
  });

  it("renders the footer attention card only when the shell is given one", () => {
    const { unmount } = renderShell();

    expect(document.querySelector('[data-slot="sidebar-attention"]')).toBeNull();
    unmount();

    const { container } = render(
      <AppShell
        activePath="/admin/overview"
        attention={{
          detail: "Day 9 of carrier vetting",
          title: "SMS still registering",
        }}
        crumbs={[{ label: "Overview" }]}
        nav={nav}
        role="admin"
      >
        <h1>Overview</h1>
      </AppShell>,
    );

    const card = container.querySelector('[data-slot="sidebar-attention"]');
    expect(card).not.toBeNull();
    expect(card).toHaveClass("border");
    expect(within(card as HTMLElement).getByText("SMS still registering")).toHaveClass(
      "font-semibold",
    );
    expect(
      within(card as HTMLElement).getByText("Day 9 of carrier vetting"),
    ).toHaveClass("text-[var(--muted)]");
  });

  it("renders the unlabelled group without a heading and labelled groups with one", () => {
    renderShell();

    expect(screen.getByRole("button", { name: "Platform" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Brain" })).toBeInTheDocument();
    const groupLabels = screen
      .getByRole("navigation", { name: "Primary" })
      .querySelectorAll('[data-slot="sidebar-group-label"]');
    expect(groupLabels).toHaveLength(2);
  });

  it("offers light, dark and system inside the account menu and no header toggle", () => {
    renderAffiliateShell();

    expect(screen.queryByRole("button", { name: "Switch to dark" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Affiliate account" }));

    const dark = screen.getByRole("menuitemradio", { name: "Dark" });
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "System" })).toBeInTheDocument();

    fireEvent.click(dark);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("mounts account security and POST-only sign-out only for a real signed-in session", () => {
    renderAffiliateShell("supabase");

    fireEvent.click(screen.getByRole("button", { name: "Affiliate account" }));

    expect(screen.getByRole("menuitem", { name: "Account security" })).toHaveAttribute(
      "href",
      "/account/security",
    );
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    expect(signOut).toHaveAttribute("type", "submit");
    expect(signOut.closest("form")).toHaveAttribute(
      "action",
      "/auth/signout?next=%2Flogin",
    );
    expect(signOut.closest("form")).toHaveAttribute("method", "post");
  });

  it("gives the demo modes a way back to the view picker instead of a sign-out with nothing to revoke", () => {
    renderAffiliateShell();

    fireEvent.click(screen.getByRole("button", { name: "Affiliate account" }));

    expect(screen.getByRole("menuitem", { name: "Switch view" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
  });

  it("applies the light default when the root has no explicit theme", () => {
    document.documentElement.classList.add("dark");

    renderShell();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute(
      "data-workspace-theme",
      "light",
    );
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("keeps a stored dark preference dark before any interaction", () => {
    const values = new Map([["setterfi:device:workspace-theme", "dark"]]);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      },
    });
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.workspaceTheme = "dark";

    renderShell();

    expect(document.documentElement).toHaveClass("dark");
  });

  it("points the header bell at the role's notifications page", () => {
    renderShell();

    const bell = screen.getByRole("link", { name: "Open notifications" });
    expect(bell).toHaveAttribute("href", "/admin/alerts");
    // It is a real anchor: no type="button" stamped on it, and no role that hides the link.
    expect(bell.tagName).toBe("A");
    expect(bell).not.toHaveAttribute("type");
    expect(bell).not.toHaveAttribute("role");
  });

  it("gives the affiliate portal no bell, because it has no notifications page", () => {
    render(
      <AppShell
        activePath="/affiliate"
        crumbs={[{ label: "Partner earnings" }]}
        nav={[{ label: "Partner earnings", items: [{ label: "Partner earnings", href: "/affiliate" }] }]}
        role="affiliate"
      >
        <h1>Partner earnings</h1>
      </AppShell>,
    );

    expect(screen.queryByRole("link", { name: "Open notifications" })).not.toBeInTheDocument();
  });

  it("marks only the matching nested destination as the current page", () => {
    render(
      <AppShell
        activePath="/admin/settings/notifications"
        crumbs={[
          { label: "Settings", href: "/admin/settings" },
          { label: "Notifications" },
        ]}
        nav={nav}
        role="admin"
      >
        <h1>Notifications</h1>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const settingsNavItem = screen
      .getAllByRole("link", { name: "Settings" })
      .find((link) => link.getAttribute("href") === "/admin/settings");
    expect(settingsNavItem).toBeDefined();
    expect(settingsNavItem).not.toHaveAttribute("aria-current");
  });

  it("renders badges and descendants for nested navigation items", () => {
    const recursiveNav: readonly NavGroup[] = [
      {
        label: "Settings",
        items: [
          {
            label: "Channels",
            href: "/admin/settings/channels",
            children: [
              {
                label: "Text messages",
                href: "/admin/settings/channels/text-messages",
                count: 4,
                children: [
                  {
                    label: "Delivery",
                    href: "/admin/settings/channels/text-messages/delivery",
                    count: 2,
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    render(
      <AppShell
        activePath="/admin/settings/channels/text-messages/delivery"
        crumbs={[
          { label: "Settings", href: "/admin/settings" },
          { label: "Delivery" },
        ]}
        nav={recursiveNav}
        role="admin"
      >
        <h1>Delivery</h1>
      </AppShell>,
    );

    const textMessages = screen.getByRole("link", { name: "Text messages" });
    const delivery = screen.getByRole("link", { name: "Delivery" });
    expect(textMessages).toHaveTextContent("4");
    expect(delivery).toHaveTextContent("2");
    expect(delivery).toHaveAttribute("aria-current", "page");
  });

  it("marks one deepest destination current when overlapping siblings both match", () => {
    // Siblings, not parent and child: the section landing and the page under it sit in the same
    // group, so nesting cannot displace either one. Both prefix-match the active path, and both
    // used to carry aria-current at once.
    const overlappingNav: readonly NavGroup[] = [
      {
        label: "Run",
        items: [
          { label: "Run", href: "/admin/run" },
          { label: "Support", href: "/admin/run/support" },
        ],
      },
    ];

    render(
      <AppShell
        activePath="/admin/run/support"
        crumbs={[{ label: "Run", href: "/admin/run" }, { label: "Support" }]}
        nav={overlappingNav}
        role="admin"
      >
        <h1>Support</h1>
      </AppShell>,
    );

    const currentLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]).toHaveAttribute("href", "/admin/run/support");
  });

  it("keeps a matchPaths alias from stealing current from a deeper destination", () => {
    const aliasNav: readonly NavGroup[] = [
      {
        label: "Run",
        items: [
          { label: "Run", href: "/admin/run", matchPaths: ["/admin/run/support"] },
          { label: "Support thread", href: "/admin/run/support/thread" },
        ],
      },
    ];

    render(
      <AppShell
        activePath="/admin/run/support/thread"
        crumbs={[{ label: "Run", href: "/admin/run" }, { label: "Support thread" }]}
        nav={aliasNav}
        role="admin"
      >
        <h1>Support thread</h1>
      </AppShell>,
    );

    const currentLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]).toHaveAttribute("href", "/admin/run/support/thread");
  });

  it("marks the ancestor of the current page without a second aria-current", () => {
    render(
      <AppShell
        activePath="/admin/settings/notifications"
        crumbs={[
          { label: "Settings", href: "/admin/settings" },
          { label: "Notifications" },
        ]}
        nav={nav}
        role="admin"
      >
        <h1>Notifications</h1>
      </AppShell>,
    );

    const settings = screen
      .getAllByRole("link", { name: "Settings" })
      .find((link) => link.getAttribute("href") === "/admin/settings");
    expect(settings).toHaveAttribute("data-active-ancestor", "");
    expect(settings).not.toHaveAttribute("aria-current");

    // The ancestry mark never doubles the current page: still exactly one aria-current in the rail.
    expect(
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page"),
    ).toHaveLength(1);
  });

  it("leaves the ancestry mark off rows the current page does not hang under", () => {
    render(
      <AppShell
        activePath="/admin/inbox"
        crumbs={[{ label: "Inbox" }]}
        nav={nav}
        role="admin"
      >
        <h1>Inbox</h1>
      </AppShell>,
    );

    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("data-active-ancestor");
    }
  });

  it("offers the workspace's real destinations, not whatever nav it was handed", () => {
    const decoyNav: readonly NavGroup[] = [
      { label: "Decoy", items: [{ label: "Not a real page", href: "/admin/nowhere" }] },
    ];

    render(
      <AppShell
        activePath="/admin"
        crumbs={[{ label: "Overview" }]}
        nav={decoyNav}
        role="admin"
      >
        <h1>Overview</h1>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const commandDialog = screen.getByRole("dialog", { name: /command palette/iu });

    // The palette is the kit's now, and it builds its destination list from the canonical
    // workspace navigation and gates every row against the role. A nav prop the shell was handed
    // for rendering the rail is not a second source of truth for what the palette will navigate
    // to -- which is the whole reason there is one palette in the repo instead of two.
    const real = workspaceNavigationFor("admin").flatMap((group) => group.items);
    expect(real.length).toBeGreaterThan(0);
    for (const item of real.slice(0, 3)) {
      expect(within(commandDialog).getByText(item.label)).toBeInTheDocument();
    }
    expect(within(commandDialog).queryByText("Not a real page")).not.toBeInTheDocument();
  });

  it("swaps nav labels for a monogram when the sidebar collapses", async () => {
    const { container } = renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));

    await waitFor(() =>
      expect(container.querySelector("[data-shell-root]")).toHaveAttribute(
        "data-sidebar",
        "collapsed",
      ),
    );

    const overviewLink = screen.getByRole("link", { name: "Overview" });
    expect(overviewLink).toHaveClass("group-data-[collapsible=icon]:justify-center");
    expect(within(overviewLink).getByText("Overview")).toHaveClass(
      "group-data-[collapsible=icon]:sr-only",
    );
    // The monogram stays rendered and transparent rather than toggling `display`, so that it can
    // fade in as the rail finishes narrowing -- an element revealed from `display: none` paints
    // straight at its final opacity and cannot transition. What marks it as the collapsed-rail
    // label is therefore the opacity it takes on, not a display class.
    expect(within(overviewLink).getByText("OV")).toHaveClass(
      "group-data-[collapsible=icon]:opacity-100",
    );
  });

  it("recalculates scroll shadows when a navigation group collapses", async () => {
    renderShell();

    const primaryNavigation = screen.getByRole("navigation", { name: "Primary" });
    const scroller = primaryNavigation.querySelector<HTMLElement>(
      '[data-slot="sidebar-content"]',
    );
    const bottomShadow = primaryNavigation.querySelector<HTMLElement>(".bottom-0");
    expect(scroller).not.toBeNull();
    expect(bottomShadow).not.toBeNull();

    let scrollHeight = 200;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    fireEvent.scroll(scroller!);
    expect(bottomShadow).not.toHaveAttribute("hidden");

    scrollHeight = 100;
    fireEvent.click(screen.getByRole("button", { name: "Platform" }));

    await waitFor(() => expect(bottomShadow).toHaveAttribute("hidden"));
  });

  it("puts the skip link first in the focus order", () => {
    const { container } = renderShell();
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    expect(focusable[0]).toBe(screen.getByRole("link", { name: "Skip to main content" }));
    expect(focusable[0]).toHaveAttribute("href", "#main");
  });

  it("closes the mobile navigation at the desktop breakpoint", () => {
    let desktopListener: ((event: MediaQueryListEvent) => void) | undefined;
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((type, listener) => {
        if (query === "(min-width: 1024px)" && type === "change") {
          desktopListener = listener as (event: MediaQueryListEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    const onOpenChange = vi.fn();

    render(
      <SidebarProvider>
        <MobileAppSidebar
          activePath="/admin/overview"
          nav={nav}
          onOpenChange={onOpenChange}
          open
        />
      </SidebarProvider>,
    );

    expect(screen.getByRole("dialog")).toHaveClass(
      "data-[side=left]:w-[var(--sidebar-w)]",
    );

    act(() => desktopListener?.({ matches: true } as MediaQueryListEvent));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    matchMedia.mockRestore();
  });
});

/*
 * What the coach shell must NOT offer.
 *
 * `AppShell` mounts no `AppSidebar` and no `MobileAppSidebar` for a coach -- the five destinations
 * are a pill bar under the header instead -- but the header went on drawing both of the controls
 * that operate them. Every coach route carried a hamburger that opened nothing and a collapse
 * toggle for a rail that was not there. Nothing caught it, because both controls render perfectly
 * well on their own; the bug is only visible if you ask what they are attached to.
 *
 * A screen reader is the reader this cost most: it announced "Open navigation" and "Toggle
 * sidebar", and a coach who followed either arrived nowhere.
 */
describe("AppShell coach navigation", () => {
  function renderCoachShell() {
    return render(
      <AppShell activePath="/coach/home" crumbs={[{ label: "Home" }]} nav={nav} role="coach">
        <h1>Home</h1>
      </AppShell>,
    );
  }

  it("offers no control for a sidebar it does not mount", () => {
    renderCoachShell();

    // The positive control. Without it a stubbed-out shell would pass every assertion below by
    // rendering nothing at all, which is the shape of vacuous test this suite has been bitten by.
    expect(screen.getByRole("heading", { name: "Home" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeVisible();

    expect(screen.queryByRole("button", { name: /toggle sidebar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open navigation/i })).toBeNull();
  });

  /*
   * Two navigations in the accessibility tree is why the coach rail is not mounted rather than
   * hidden: a hidden rail is still announced, and a coach tabbing through the page would meet the
   * five destinations twice.
   */
  it("exposes exactly one navigation for the surface's own destinations", () => {
    renderCoachShell();

    const sections = screen.getAllByRole("navigation").filter(
      (node) => node.getAttribute("aria-label") === "Sections",
    );
    expect(sections).toHaveLength(1);
  });
});

/*
 * The support bubble and the room the phone tab bar needs.
 *
 * Both of these are shell-level facts that no page can assert for itself, and both went wrong the
 * same way: a component or a rule existed, was correct, and was attached to nothing. The bubble
 * was finished and tested and rendered on no page in the product; the phone bar was `fixed` to the
 * bottom edge with nothing in the flow reserving its height, so the last row of every coach page
 * sat under it. `coach-pillbar.tsx` reported the second one rather than reaching into this file.
 */
/*
 * The rail width is a shared number: `admin/console.css` computes the deck's column count from
 * "the window minus a 246px rail", and the shell is where that rail's width is actually set. They
 * disagreed by 46px for the whole redesign pass, which is invisible in either file alone.
 */
describe("AppShell rail width", () => {
  it("gives the console the 246px rail its own stylesheet lays out against", () => {
    renderShell();
    const root = document.querySelector("[data-shell-root]") as HTMLElement;
    expect(root.style.getPropertyValue("--sidebar-width")).toBe("246px");
  });

  it("keeps the coach rail at 186px, which is a different density on purpose", () => {
    render(
      <AppShell activePath="/coach/home" crumbs={[{ label: "Home" }]} nav={nav} role="coach">
        <h1>Home</h1>
      </AppShell>,
    );
    const root = document.querySelector("[data-shell-root]") as HTMLElement;
    expect(root.style.getPropertyValue("--sidebar-width")).toBe("186px");
  });
});

describe("AppShell coach chrome", () => {
  function renderCoachShell() {
    return render(
      <AppShell activePath="/coach/home" crumbs={[{ label: "Home" }]} nav={nav} role="coach">
        <h1>Home</h1>
      </AppShell>,
    );
  }

  it("mounts the support bubble on a coach surface and nowhere else", () => {
    renderCoachShell();
    expect(screen.getByRole("button", { name: "Get help" })).toBeVisible();
  });

  it("does not mount it in the owner console, which has its own help route", () => {
    renderShell();
    expect(screen.queryByRole("button", { name: "Get help" })).toBeNull();
  });

  it("keeps the bubble outside <main>, so it is not inside the landmark it floats over", () => {
    renderCoachShell();
    const launcher = screen.getByRole("button", { name: "Get help" });
    expect(document.getElementById("main")?.contains(launcher)).toBe(false);
  });

  it("reserves the phone tab bar's height at the foot of the coach page", () => {
    renderCoachShell();
    expect(document.getElementById("main")?.className).toContain(
      "max-sm:pb-[calc(56px+16px+env(safe-area-inset-bottom))]",
    );
  });

  it("leaves the owner console's <main> unpadded, because it has no fixed bottom bar", () => {
    renderShell();
    expect(document.getElementById("main")?.className).not.toContain("env(safe-area-inset-bottom)");
  });
});

/*
 * The account chip's identity.
 *
 * The trigger rendered the literal string "CO" for every coach on the product and the menu was
 * headed "Coach account", because nothing above a page knew who was signed in. The workspace
 * layout reads a display name once per request now and hands it down through `WorkspaceEnvProvider`.
 *
 * The absent case is the one worth guarding hardest: no name must produce the old round initials
 * button, never a chip with a placeholder person in it.
 */
describe("AppShell account identity", () => {
  function renderWithAccount(account?: {
    fullName: string | null;
    firstName: string | null;
    business: string | null;
  }) {
    return render(
      <WorkspaceEnvProvider
        account={account}
        demoAccountSwitching={false}
        demoViews={demoViewTargets}
        mode="supabase"
      >
        <AppShell activePath="/coach/home" crumbs={[{ label: "Home" }]} nav={nav} role="coach">
          <h1>Home</h1>
        </AppShell>
      </WorkspaceEnvProvider>,
    );
  }

  const marcus = { fullName: "Marcus Reid", firstName: "Marcus", business: "Reid Funding Group" };

  it("puts the person's initials and first name in the trigger", () => {
    renderWithAccount(marcus);
    const trigger = screen.getByRole("button", { name: "Coach account" });

    expect(within(trigger).getByText("MR")).toBeVisible();
    expect(within(trigger).getByText("Marcus")).toBeVisible();
    expect(within(trigger).queryByText("CO")).toBeNull();
  });

  it("heads the affiliate menu with the person and their business", () => {
    render(
      <WorkspaceEnvProvider
        account={marcus}
        demoAccountSwitching={false}
        demoViews={demoViewTargets}
        mode="supabase"
      >
        <AppShell activePath="/affiliate" crumbs={[{ label: "Partner earnings" }]} role="affiliate">
          <h1>Partner earnings</h1>
        </AppShell>
      </WorkspaceEnvProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Affiliate account" }));

    // `toBeInTheDocument` rather than `toBeVisible`: the menu content is portalled and Base UI
    // mounts it before the open transition has settled, so visibility here would be asserting
    // the animation rather than the header.
    expect(screen.getByText("Marcus Reid")).toBeInTheDocument();
    expect(screen.getByText("Reid Funding Group")).toBeInTheDocument();
    expect(screen.queryByText("Affiliate account")).toBeNull();
  });

  it("keeps the role's accessible name on the button whatever the header shows", () => {
    renderWithAccount(marcus);
    // The header naming a person does not tell a screen reader which account the menu opens.
    expect(screen.getByRole("button", { name: "Coach account" })).toBeVisible();
  });

  /*
   * The fallback is the square, not a chip with a placeholder person in it. It used to be a round
   * 32px button, which was the console's control; the coach bar is 76px and every other control in
   * it -- the bell, the named chip, each pill -- is 46px, so the fallback is the same square with
   * the name and the chevron taken out of it. What the assertion is about is unchanged: initials
   * only, no invented name, and visibly not the named chip.
   */
  it("falls back to the role's initials square rather than a placeholder person", () => {
    renderWithAccount(undefined);
    const trigger = screen.getByRole("button", { name: "Coach account" });

    expect(within(trigger).getByText("CO")).toBeVisible();
    expect(trigger.className).toContain("size-[46px]");
    expect(trigger.className).not.toContain("pl-[8px]");
    expect(within(trigger).queryByText("Marcus")).toBeNull();
  });

  it("greets the support bubble's reader by name when there is one, and nobody when there is not", () => {
    const named = renderWithAccount(marcus);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    expect(screen.getByRole("heading", { name: "Need a hand, Marcus?" })).toBeVisible();
    named.unmount();

    renderWithAccount(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    expect(screen.getByRole("heading", { name: "Need a hand?" })).toBeVisible();
  });
});

/*
 * The coach top bar.
 *
 * Every coach artboard draws the same 76px bar: a mark and a "Your agent" lockup at the left, the
 * five destination pills centred inside it, a bell and a named account chip at the right, and no
 * breadcrumbs and no search box anywhere. The code shipped the console's 52px bar with crumbs, a
 * palette button and a "CO" initials button, and rendered the pills as the first child of `<main>`
 * -- so the navigation was inside the page rather than around it, on all seven coach screens.
 *
 * These assert the two halves that a re-fork would quietly undo: that the bar is one component
 * with two presentations, and that the console's presentation did not move. A test that only
 * checked the coach side would pass just as happily against two files.
 */
describe("AppShell top bar, two densities", () => {
  function renderCoach() {
    return render(
      <AppShell activePath="/coach/home" crumbs={[{ label: "Home" }]} nav={nav} role="coach">
        <h1>Home</h1>
      </AppShell>,
    );
  }

  it("puts the coach's destinations in the bar rather than inside the page", () => {
    renderCoach();
    const sections = screen
      .getAllByRole("navigation")
      .find((node) => node.getAttribute("aria-label") === "Sections")!;

    expect(document.querySelector("header")!.contains(sections)).toBe(true);
    expect(document.getElementById("main")!.contains(sections)).toBe(false);
  });

  it("carries the lockup on the coach bar and nowhere else", () => {
    renderCoach();
    expect(screen.getByText("Your agent")).toBeInTheDocument();

    cleanup();
    renderShell();
    expect(screen.queryByText("Your agent")).toBeNull();
  });

  it("kills the breadcrumbs and the search box on the coach bar", () => {
    renderCoach();
    expect(screen.queryByLabelText("Breadcrumb")).toBeNull();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  });

  it("keeps both of them in the owner console, which is a different density on purpose", () => {
    renderShell();
    expect(screen.getByLabelText("Breadcrumb")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });

  it("leaves the console's own destinations in the rail and not in its bar", () => {
    renderShell();
    const primary = screen
      .getAllByRole("navigation")
      .find((node) => node.getAttribute("aria-label") === "Primary")!;

    expect(document.querySelector("header")!.contains(primary)).toBe(false);
  });
});

/*
 * The rail's role pill.
 *
 * `AdminOverview.dc.html` draws a mono "OWNER" pill at the right of the rail header, and it is
 * drawn on an owner's screen. The admin workspace serves four platform roles and the topbar's own
 * least-privilege fallback is `success`, so a pill hard-coded to OWNER would be a false statement
 * about three of them and about every session whose role could not be read. The pill is a
 * pseudo-element keyed to this attribute, so the attribute is where the honesty lives.
 */
describe("AppShell platform role", () => {
  it("stamps the resolved role on the shell root, for the rail's role pill", () => {
    render(
      <AppShell
        activePath="/admin/overview"
        crumbs={[{ label: "Overview" }]}
        nav={nav}
        platformRole="success"
        role="admin"
      >
        <h1>Overview</h1>
      </AppShell>,
    );
    const root = document.querySelector("[data-shell-root]") as HTMLElement;
    expect(root.dataset.platformRole).toBe("success");
  });

  it("stamps nothing when no role resolved, so no session is labelled a role it may not have", () => {
    renderShell();
    const root = document.querySelector("[data-shell-root]") as HTMLElement;
    expect(root.dataset.platformRole).toBeUndefined();
  });
});

/**
 * The rail's fleet card, drawn on 24 of the 25 admin artboards
 * (`AdminClients.dc.html:190-203`).
 *
 * Three of these five guard a way the card can be wrong *without looking wrong*, which is the
 * only reason they are worth their length: a leak that renders identically on the wrong rail, a
 * total that disagrees with its own segments, and a fill that resolves to nothing in a portal.
 */
describe("AppShell rail fleet health", () => {
  const fleet = { live: 21, registering: 2, paused: 1 };

  function renderAdminShell(props: Partial<React.ComponentProps<typeof AppShell>> = {}) {
    return render(
      <AppShell
        activePath="/admin/overview"
        crumbs={[{ label: "Overview" }]}
        fleet={fleet}
        nav={nav}
        role="admin"
        {...props}
      >
        <h1>Overview</h1>
      </AppShell>,
    );
  }

  it("draws the counts as the canvas words them, with registering said in full", () => {
    renderAdminShell();
    const card = document.querySelector('[data-slot="sidebar-fleet-health"]') as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(
      card.querySelector('[data-slot="sidebar-fleet-health-counts"]')?.textContent,
    ).toBe("21 live · 2 registering · 1 paused");
  });

  /*
   * The honest-states rule, at the one place on the rail it could be broken. "Registering" is a
   * real carrier state that genuinely runs two to three weeks, so the card may never soften it
   * into "setting up", express it as a share of a filing, or name the day it ends.
   */
  it("never states the carrier wait as a percentage, a date, or a softer word", () => {
    renderAdminShell();
    const card = document.querySelector('[data-slot="sidebar-fleet-health"]') as HTMLElement;
    expect(card.textContent).toMatch(/registering/);
    expect(card.textContent).not.toMatch(/%|setting up|almost|soon|by |ready in/i);
  });

  /*
   * The total is the sum and is never sourced separately, so the header cannot contradict the bar
   * beneath it. Reading it off the DOM rather than off the input is the point: a future refactor
   * that threads a fourth number in would fail here.
   */
  it("prints a total that is its own segments added up", () => {
    renderAdminShell();
    const card = document.querySelector('[data-slot="sidebar-fleet-health"]') as HTMLElement;
    const total = card.querySelector('[data-slot="sidebar-fleet-health-total"]')?.textContent ?? "";
    const counts = card.querySelector('[data-slot="sidebar-fleet-health-counts"]')?.textContent ?? "";
    const summed = [...counts.matchAll(/(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(total).toBe(`${summed} agents`);
  });

  /*
   * Cross-tenant counts on a non-admin rail would be a tenant-isolation breach on every screen at
   * once, because the rail is chrome. The shell drops them on `role`, so handing them over by
   * mistake is not enough to leak them.
   *
   * **This is the affiliate rail and not the coach one, and that is the whole test.** Written
   * against `role="coach"` it passed with the guard deleted, because the coach surface navigates
   * from a pill bar and mounts no sidebar at all (`app-shell.tsx`, the `role === "coach"` branch) --
   * so it measured the absence of a rail and never the guard in its name. The affiliate rail is a
   * real rail, which makes this the one role that can actually catch the leak. Verified by
   * deleting the guard and watching it go red.
   */
  it("drops the card on an affiliate rail even when it is handed one", () => {
    render(
      <AppShell
        activePath="/affiliate"
        crumbs={[{ label: "Affiliate" }]}
        fleet={fleet}
        role="affiliate"
      >
        <h1>Affiliate</h1>
      </AppShell>,
    );
    expect(document.querySelector('[data-slot="sidebar"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar-fleet-health"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Platform health/);
  });

  /*
   * The fill has to survive the mobile rail, which Radix portals to `document.body` -- outside
   * the `[data-shell-role="admin"]` subtree where `--console-drench-live` is declared. An
   * unresolved custom property drops its whole declaration, so a token with no fallback would
   * leave this card with no ground and near-white text on a pale sheet, silently. The rule is
   * asserted from the stylesheet the shell injects, because that is the artefact that ships.
   */
  it("keeps a literal behind the drench token, so the mobile portal still has a ground", () => {
    renderAdminShell();
    const sheet = [...document.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .find((text) => text.includes('[data-slot="sidebar-fleet-health"]')) ?? "";
    const fill = sheet.match(/\[data-slot="sidebar-fleet-health"\]\s*\{[^}]*background:([^;]+);/)?.[1] ?? "";
    expect(fill).toContain("--console-drench-live");
    expect(fill).toMatch(/--console-drench-live\s*,\s*linear-gradient\(/);
  });
});
