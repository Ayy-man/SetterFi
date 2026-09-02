"use client";

/**
 * Where the command palette's Clients group gets its rows.
 *
 * `CommandPalette` takes a synchronous `searchClients(query)` and never fetches -- that is
 * deliberate, because the palette re-asks on every keystroke and a network round trip per
 * character is the wrong shape. The question this module answers is who supplies the answer.
 *
 * Not the shell: it renders above every workspace page and holds no client list, so wiring the
 * palette there would mean a new query on every page load in every workspace, for a feature only
 * the admin console uses. Instead a page that *already* loaded a client list registers it here on
 * mount, and the palette in the topbar reads it out of context. The Client book pays nothing
 * because it already has the rows; every other page contributes nothing and costs nothing.
 *
 * The consequence, stated plainly so nobody reads it as a bug: the Clients group is populated only
 * while a page that registers clients is mounted. Open the palette on the Audit log and it offers
 * destinations and actions but no clients. Making it universal needs a real client-search endpoint,
 * which is a backend task, not this one.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * One client row the palette can offer. Structurally the palette's own `PaletteClient` -- kept as
 * its own declaration here rather than imported so a page feeding the registry does not have to
 * depend on the palette module.
 */
export type PaletteClientEntry = {
  id: string;
  label: string;
  href: string;
  /** The mono column on the right. A kind, never a status. */
  kind?: string;
  keywords?: readonly string[];
};

type PaletteClientRegistry = {
  clients: readonly PaletteClientEntry[];
  register: (key: string, clients: readonly PaletteClientEntry[]) => void;
  unregister: (key: string) => void;
};

const EMPTY: readonly PaletteClientEntry[] = [];

const PaletteClientContext = createContext<PaletteClientRegistry | null>(null);

export function PaletteClientProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<Record<string, readonly PaletteClientEntry[]>>({});

  const register = useCallback((key: string, clients: readonly PaletteClientEntry[]) => {
    setSources((current) => ({ ...current, [key]: clients }));
  }, []);

  const unregister = useCallback((key: string) => {
    setSources((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  // Keyed by source, then flattened, so two panels on one page each contribute without either
  // clobbering the other, and a row that appears in both is offered once.
  const clients = useMemo(() => {
    const seen = new Set<string>();
    return Object.values(sources).flat().filter((client) => {
      if (seen.has(client.id)) return false;
      seen.add(client.id);
      return true;
    });
  }, [sources]);

  const value = useMemo<PaletteClientRegistry>(
    () => ({ clients, register, unregister }),
    [clients, register, unregister],
  );

  return (
    <PaletteClientContext.Provider value={value}>{children}</PaletteClientContext.Provider>
  );
}

/**
 * Publishes a page's client list to the palette for as long as the page is mounted.
 *
 * Renders nothing. `key` names the source so a page can re-register a changed list -- a filter
 * applied, a page of results turned -- without leaving the previous one behind.
 */
export function RegisterPaletteClients({
  clients,
  sourceKey,
}: {
  clients: readonly PaletteClientEntry[];
  sourceKey: string;
}) {
  const registry = useContext(PaletteClientContext);
  const register = registry?.register;
  const unregister = registry?.unregister;

  useEffect(() => {
    if (!register || !unregister) return;
    register(sourceKey, clients);
    return () => unregister(sourceKey);
  }, [clients, register, sourceKey, unregister]);

  return null;
}

/**
 * The synchronous source `CommandPalette` asks on every keystroke.
 *
 * Matching is a plain substring over the label and the row's own keywords, case-folded. It is not
 * fuzzy and it is not ranked: cmdk orders what it is handed, and a registry of a few dozen rows
 * does not need a scorer. An empty query offers the first handful rather than nothing, so opening
 * the palette on the Client book shows what is there before you type.
 *
 * Returns `undefined` when no page has registered anything, which is what makes the palette drop
 * the Clients group entirely rather than render an empty one.
 */
export function usePaletteClientSearch():
  | ((query: string) => readonly PaletteClientEntry[])
  | undefined {
  const registry = useContext(PaletteClientContext);
  const clients = registry?.clients ?? EMPTY;

  const search = useCallback(
    (query: string) => {
      const needle = query.trim().toLocaleLowerCase();
      if (!needle) return clients.slice(0, 6);
      return clients.filter((client) =>
        [client.label, ...(client.keywords ?? [])].some((term) =>
          term.toLocaleLowerCase().includes(needle),
        ),
      );
    },
    [clients],
  );

  return clients.length > 0 ? search : undefined;
}
