"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export const RESERVED_QUERY_KEYS = [
  "view",
  "q",
  "sort",
  "cols",
  "density",
] as const;

export type ReservedQueryKey = (typeof RESERVED_QUERY_KEYS)[number];
export type QueryStateValue = string | readonly string[] | null | undefined;

export type QueryState = {
  searchParams: ReturnType<typeof useSearchParams>;
  get: (key: string) => string | null;
  getAll: (key: string) => string[];
  has: (key: string, value?: string) => boolean;
  set: (key: string, value: QueryStateValue) => void;
  setMany: (updates: Readonly<Record<string, QueryStateValue>>) => void;
  toggle: (key: string, value: string, checked?: boolean) => void;
  remove: (key: string, value?: string) => void;
  clear: (keys?: readonly string[]) => void;
};

function writeValue(params: URLSearchParams, key: string, value: QueryStateValue) {
  params.delete(key);

  if (value == null || value === "") {
    return;
  }

  const values = typeof value === "string" ? [value] : value;
  for (const item of values) {
    if (item !== "") {
      params.append(key, item);
    }
  }
}

export function useQueryState(): QueryState {
  const { replace: routerReplace } = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const source = searchParams.toString();
  const pendingRef = useRef(new URLSearchParams(source));

  useEffect(() => {
    pendingRef.current = new URLSearchParams(source);
  }, [source]);

  const replace = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const next = new URLSearchParams(pendingRef.current);
      update(next);
      pendingRef.current = next;

      const query = next.toString();
      routerReplace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, routerReplace],
  );

  const get = useCallback((key: string) => searchParams.get(key), [searchParams]);
  const getAll = useCallback((key: string) => searchParams.getAll(key), [searchParams]);
  const has = useCallback(
    (key: string, value?: string) =>
      value === undefined ? searchParams.has(key) : searchParams.getAll(key).includes(value),
    [searchParams],
  );
  const set = useCallback(
    (key: string, value: QueryStateValue) => {
      replace((params) => writeValue(params, key, value));
    },
    [replace],
  );
  const setMany = useCallback(
    (updates: Readonly<Record<string, QueryStateValue>>) => {
      replace((params) => {
        for (const [key, value] of Object.entries(updates)) {
          writeValue(params, key, value);
        }
      });
    },
    [replace],
  );
  const toggle = useCallback(
    (key: string, value: string, checked?: boolean) => {
      replace((params) => {
        const values = params.getAll(key);
        const includesValue = values.includes(value);
        const shouldInclude = checked ?? !includesValue;

        if (shouldInclude === includesValue) {
          return;
        }

        writeValue(
          params,
          key,
          shouldInclude ? [...values, value] : values.filter((item) => item !== value),
        );
      });
    },
    [replace],
  );
  const remove = useCallback(
    (key: string, value?: string) => {
      replace((params) => {
        if (value === undefined) {
          params.delete(key);
          return;
        }

        const remaining = params.getAll(key).filter((item) => item !== value);
        writeValue(params, key, remaining);
      });
    },
    [replace],
  );
  const clear = useCallback(
    (keys?: readonly string[]) => {
      replace((params) => {
        if (keys === undefined) {
          for (const key of Array.from(params.keys())) {
            params.delete(key);
          }
          return;
        }

        for (const key of keys) {
          params.delete(key);
        }
      });
    },
    [replace],
  );

  return { searchParams, get, getAll, has, set, setMany, toggle, remove, clear };
}
