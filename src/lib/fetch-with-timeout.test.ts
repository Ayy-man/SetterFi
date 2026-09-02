import { afterEach, describe, expect, it, vi } from "vitest"

import { FetchTimeoutError, fetchWithTimeout } from "@/lib/fetch-with-timeout"

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects a hanging fetch at the timeout and identifies the resource path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
      ),
    )

    const request = fetchWithTimeout("https://app.setterfi.test/api/alerts?window=all", {
      timeoutMs: 10,
    })

    await expect(request).rejects.toMatchObject({
      name: "FetchTimeoutError",
      resource: "/api/alerts",
      message: "Request timed out for /api/alerts",
    } satisfies Partial<FetchTimeoutError>)
  })
})
