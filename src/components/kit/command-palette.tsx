"use client"

import { Check } from "@/components/kit/icons";
import type { KitIcon } from "@/components/kit/icons";

import Link from "next/link"
import { motion, useReducedMotion, type Transition } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import type { UserRole } from "@/lib/auth/claims"
import { workspaceForRole } from "@/lib/auth/claims"
import {
  isWorkspaceNavItemActive,
  workspaceNavigationFor,
  workspaceRoleMeta,
  type WorkspaceNavItem,
} from "@/lib/workspace-navigation"

const MONEY_DESTINATION_PREFIXES = [
  "/admin/tiers",
  "/admin/billing",
  "/admin/corrections",
  "/admin/affiliates",
] as const

/**
 * One client row the palette can offer. Deliberately the smallest shape a page can build from
 * whatever it already holds -- a loaded table, a cached list, a client store -- so feeding the
 * palette never means fetching anything a second time.
 */
type PaletteClient = {
  id: string
  label: string
  href: string
  /** The mono column on the right. Defaults to "Client"; keep it a kind, not a status. */
  kind?: string
  keywords?: readonly string[]
}

/**
 * The pluggable source. Synchronous by design: the palette asks on every keystroke and a page that
 * owns its client list answers from memory. There is no search route behind this and the palette
 * itself never fetches -- an owner that needs the network keeps its own results in state and
 * returns the current slice from here.
 */
type PaletteClientSearch = (query: string) => readonly PaletteClient[]

type PaletteDestination = {
  id?: string
  label: string
  href: string
  icon?: KitIcon
  keywords?: readonly string[]
}

type CommandPaletteDestination = PaletteDestination & {
  allowedRoles: readonly UserRole[]
}

type CommandPaletteAction = {
  id: string
  label: string
  onSelect: () => void
  icon?: KitIcon
  keywords?: readonly string[]
  allowedRoles: readonly UserRole[]
}

type CommandPaletteProps = {
  role: UserRole
  activePath?: string
  recent?: readonly CommandPaletteDestination[]
  actions?: readonly CommandPaletteAction[]
  /**
   * Feeds the Clients group. Called with the live query while the palette is open; return an empty
   * array for a query you have nothing for and the group disappears. Results are still role-gated
   * here, so a source that hands back an out-of-workspace or money href is dropped, not shown.
   */
  searchClients?: PaletteClientSearch
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  onNavigate?: (href: string) => void
}

type GoToDestination = WorkspaceNavItem & {
  groupLabel: string
}

/**
 * `--duration-fast` on `--ease-smooth-out`, restated as numbers because Motion cannot read a CSS
 * custom property. The palette arrives from just above the resting position and settles; reduced
 * motion gets the same end state with no travel, decided in JS through `useReducedMotion` because
 * `globals.css` owns the app's one reduced-motion block.
 */
const PALETTE_OPEN_TRANSITION: Transition = {
  duration: 0.25,
  ease: [0.22, 1, 0.36, 1],
  type: "tween",
}

/** The right-hand column: where a row goes, or what kind of thing it is. Mono 11, faint. */
const PALETTE_KIND_CLASS =
  "ml-auto shrink-0 text-right font-mono text-[length:var(--t-mono-crumb)] leading-[var(--t-mono-crumb-lh)] text-[var(--faint)]"

/**
 * A nav tree, flattened.
 *
 * The rail nests -- Channels, then Text messages, then Delivery -- and only the leaf is a page a
 * reader would search for by name. Mapping the top level alone meant a palette that could not find
 * any destination more than one level deep, which is most of the settings tree.
 */
function flattenNavItems(items: readonly WorkspaceNavItem[]): WorkspaceNavItem[] {
  return items.flatMap((item) => [item, ...flattenNavItems(item.children ?? [])])
}

/**
 * One shape for every path the gates below compare.
 *
 * The workspace and money checks were raw `startsWith` calls against whatever string a caller
 * handed in, so `/admin/Billing`, `/admin/billing/`, and `/admin/billing?tenant=t1` each read as a
 * different destination from `/admin/billing` -- and the first of those let a money row past a
 * role that may not see money. Worse, `/admin/clients/../billing` passed the money gate outright
 * and still resolved to `/admin/billing` once the router walked it. Query and fragment carry no
 * routing decision, a trailing slash and a doubled slash name the same route, dot segments are
 * resolved before anything is routed, and app routes are lowercase, so all of it collapses here
 * before a decision is made. Anything that is not an internal absolute path returns null and is
 * refused rather than guessed at.
 */
export function canonicalInternalPath(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null

  const raw = trimmed.split(/[?#]/u)[0].toLowerCase()
  const resolved: string[] = []
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue
    // A `..` above the root is dropped rather than escaping it, which is what the router does.
    if (segment === "..") {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.length === 0 ? "/" : `/${resolved.join("/")}`
}

function isMoneyDestination(href: string) {
  const path = canonicalInternalPath(href)
  return path !== null && MONEY_DESTINATION_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function destinationWorkspace(href: string) {
  const path = canonicalInternalPath(href)
  if (path === null) return null
  if (path === "/admin" || path.startsWith("/admin/")) return "admin"
  if (path === "/coach" || path.startsWith("/coach/")) return "coach"
  if (path === "/affiliate" || path.startsWith("/affiliate/")) return "affiliate"
  return null
}

function canRoleSeeHref(role: UserRole, href: string) {
  // A path that does not canonicalize names no workspace, so it is refused rather than compared
  // against a role that happens to have no workspace of its own.
  if (canonicalInternalPath(href) === null) return false
  if (destinationWorkspace(href) !== workspaceForRole(role)) return false
  if (role !== "owner" && role !== "admin" && isMoneyDestination(href)) return false
  return true
}

function canRoleSeeRecentDestination(role: UserRole, item: CommandPaletteDestination) {
  if (item.allowedRoles?.includes(role) !== true) return false
  return canRoleSeeHref(role, item.href)
}

function canRoleSeeGoToDestination(role: UserRole, item: WorkspaceNavItem) {
  if (role !== "owner" && role !== "admin" && isMoneyDestination(item.href)) return false
  return true
}

function roleLabel(role: UserRole) {
  if (role === "owner") return "Owner"
  if (role === "success") return "Success"
  if (role === "build") return "Build"
  if (role === "coach_member") return "Coach"

  const workspace = workspaceForRole(role)
  return workspace ? workspaceRoleMeta[workspace].label : "Workspace"
}

function restoreFocus(element: HTMLElement | null) {
  if (!element) return
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => element.focus())
    return
  }
  element.focus()
}

function CommandPalette({
  role,
  activePath = "",
  recent = [],
  actions = [],
  searchClients,
  open,
  defaultOpen = false,
  onOpenChange,
  onNavigate,
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const [query, setQuery] = useState("")
  const reduced = useReducedMotion()
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const isControlled = open !== undefined
  const paletteOpen = open ?? internalOpen
  const workspace = workspaceForRole(role)

  const setPaletteOpen = useCallback((nextOpen: boolean, shouldRestoreFocus = false) => {
    if (!isControlled) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
    if (!nextOpen && shouldRestoreFocus) restoreFocus(returnFocusRef.current)
  }, [isControlled, onOpenChange])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        returnFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
        setPaletteOpen(true)
        return
      }

      if (event.key === "Escape" && paletteOpen) {
        event.preventDefault()
        setPaletteOpen(false, true)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [paletteOpen, setPaletteOpen])

  const goTo = useMemo<readonly GoToDestination[]>(() => {
    if (!workspace) return []
    return workspaceNavigationFor(workspace)
      .flatMap((group) =>
        flattenNavItems(group.items).map((item) => ({ ...item, groupLabel: group.label }))
      )
      .filter((item) => canRoleSeeGoToDestination(role, item))
  }, [role, workspace])

  const visibleRecent = useMemo(
    () => recent.filter((item) => canRoleSeeRecentDestination(role, item)),
    [recent, role]
  )
  /**
   * Client rows are gated exactly like a nav destination: an href outside this role's workspace,
   * or a money destination for a role that cannot see money, never reaches the list no matter what
   * the source returns.
   */
  const visibleClients = useMemo<readonly PaletteClient[]>(() => {
    if (!searchClients) return []
    return searchClients(query).filter((client) => canRoleSeeHref(role, client.href))
  }, [query, role, searchClients])

  const visibleActions = useMemo(
    () => actions.filter((item) => item.allowedRoles.includes(role)),
    [actions, role]
  )

  function closeAfterSelection() {
    setPaletteOpen(false, true)
  }

  function handleNavigate(href: string) {
    if (onNavigate) onNavigate(href)
    else window.location.assign(href)
    closeAfterSelection()
  }

  function destinationItem(
    item: PaletteDestination,
    detail?: string,
    extraKeywords: readonly string[] = []
  ) {
    const Icon = item.icon
    const navigationItem = goTo.find((destination) => destination.href === item.href)
    // The rail's matcher compares whole path segments, so it needs the canonical reading of the
    // route the reader is on: `/admin/billing/` and `/admin/billing?tab=costs` are that route.
    const canonicalActivePath = canonicalInternalPath(activePath)
    const active = canonicalActivePath !== null && navigationItem
      ? isWorkspaceNavItemActive(navigationItem, canonicalActivePath)
      : false

    return (
      <CommandItem
        className="rounded-[var(--r-input)] p-0 text-body"
        key={item.id ?? item.href}
        keywords={[...(item.keywords ?? []), ...extraKeywords, detail ?? ""]}
        onSelect={() => handleNavigate(item.href)}
        // A query handed in as an extra keyword is folded into the searchable value too, so
        // cmdk's own filter cannot drop a row an external source already decided matches: the
        // source is the authority on client matching, cmdk only orders what it is handed.
        value={`${item.label} ${detail ?? ""} ${extraKeywords.join(" ")}`}
      >
        <Link
          className="flex w-full items-center gap-[var(--s-3)] rounded-[var(--r-input)] px-[var(--s-2)] py-[var(--s-2)] text-[var(--ink)] no-underline"
          href={item.href}
          onClick={(event) => {
            event.stopPropagation()
            if (onNavigate) {
              event.preventDefault()
              onNavigate(item.href)
            }
            closeAfterSelection()
          }}
        >
          {Icon ? <Icon aria-hidden className="size-[var(--s-4)] shrink-0 text-[var(--muted)]" /> : null}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {detail ? (
            <span className={PALETTE_KIND_CLASS} data-slot="palette-kind">
              {detail}
            </span>
          ) : null}
          {active ? <Check aria-label="Current page" className="size-[var(--s-4)] shrink-0" /> : null}
        </Link>
      </CommandItem>
    )
  }

  return (
    <CommandDialog
      className="top-[calc(var(--topbar-h)_+_var(--s-12))]! max-h-[calc(100dvh_-_var(--topbar-h)_-_var(--s-12))] translate-y-0! rounded-[var(--r-panel)]! border border-[var(--line)] bg-[var(--raised)] shadow-[var(--shadow-modal)] sm:max-w-[var(--drawer-w)]! motion-reduce:animate-none motion-reduce:transition-none"
      description={`Search navigation and actions available to the ${roleLabel(role).toLowerCase()} role.`}
      onOpenChange={(nextOpen) => setPaletteOpen(nextOpen, !nextOpen)}
      open={paletteOpen}
      title={`${roleLabel(role)} command palette`}
    >
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        data-slot="palette-motion"
        initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: -6 }}
        transition={reduced ? { duration: 0 } : PALETTE_OPEN_TRANSITION}
      >
        <Command
          className="rounded-[var(--r-panel)]! bg-[var(--raised)] p-[var(--s-1)] text-[var(--ink)]"
          label={`${roleLabel(role)} workspace commands`}
          loop
        >
          <CommandInput
            aria-label="Search workspace"
            autoFocus
            className="text-body text-[var(--ink)] placeholder:text-[var(--faint)]"
            onValueChange={setQuery}
            placeholder={`Search ${roleLabel(role).toLowerCase()} workspace`}
            value={query}
          />
          <CommandList className="max-h-[calc(var(--row-h-comfortable)*6)] py-[var(--s-1)]">
            <CommandEmpty className="px-[var(--s-4)] py-[var(--s-8)] text-body text-[var(--muted)]">
              No matching destination or action.
            </CommandEmpty>

            <CommandGroup heading="Pages">
              {goTo.map((item) => destinationItem(item, item.groupLabel))}
            </CommandGroup>

            {visibleClients.length > 0 ? (
              <>
                <CommandSeparator className="bg-[var(--line)]" />
                <CommandGroup heading="Clients">
                  {visibleClients.map((client) =>
                    destinationItem(
                      {
                        href: client.href,
                        id: client.id,
                        keywords: client.keywords,
                        label: client.label,
                      },
                      client.kind ?? "Client",
                      [query]
                    )
                  )}
                </CommandGroup>
              </>
            ) : null}

            {visibleRecent.length > 0 ? (
              <>
                <CommandSeparator className="bg-[var(--line)]" />
                <CommandGroup heading="Recent">
                  {visibleRecent.map((item) => destinationItem(item, "Recent"))}
                </CommandGroup>
              </>
            ) : null}

            {visibleActions.length > 0 ? (
              <>
                <CommandSeparator className="bg-[var(--line)]" />
                <CommandGroup heading="Actions">
                  {visibleActions.map((item) => {
                    const Icon = item.icon
                    return (
                      <CommandItem
                        className="rounded-[var(--r-input)] px-[var(--s-2)] py-[var(--s-2)] text-body"
                        key={item.id}
                        keywords={[...(item.keywords ?? [])]}
                        onSelect={() => {
                          item.onSelect()
                          closeAfterSelection()
                        }}
                        value={item.label}
                      >
                        {Icon ? <Icon aria-hidden className="size-[var(--s-4)] shrink-0 text-[var(--muted)]" /> : null}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        <span className={PALETTE_KIND_CLASS} data-slot="palette-kind">
                          Action
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </motion.div>
    </CommandDialog>
  )
}

export { CommandPalette, MONEY_DESTINATION_PREFIXES }
export type {
  CommandPaletteAction,
  CommandPaletteDestination,
  CommandPaletteProps,
  PaletteClient,
  PaletteClientSearch,
}
