const DEFAULT_TIMEOUT_MS = 12_000

function resourcePath(input: RequestInfo): string {
  const resource = typeof input === "string" ? input : input.url

  try {
    return new URL(resource, "http://localhost").pathname
  } catch {
    return resource
  }
}

export class FetchTimeoutError extends Error {
  readonly resource: string

  constructor(resource: string) {
    super(`Request timed out for ${resource}`)
    this.name = "FetchTimeoutError"
    this.resource = resource
  }
}

export async function fetchWithTimeout(
  input: RequestInfo,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...requestInit } = init
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetch(input, { ...requestInit, signal })
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new FetchTimeoutError(resourcePath(input))
    }

    throw error
  }
}
