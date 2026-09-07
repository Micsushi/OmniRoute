export const CONTRACT_VERSION = "1.0.0";

export class OmniRouteError extends Error {
  constructor(message, { status, code, requestId, details } = {}) {
    super(message);
    this.name = "OmniRouteError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

function stripVersionSuffix(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "baseUrl must be an HTTP(S) gateway URL without credentials, query or fragment"
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

async function readError(response) {
  let body = null;
  try {
    body = await response.clone().json();
  } catch {
    try {
      body = await response.text();
    } catch {}
  }
  const structured = body && typeof body === "object" ? body.error : null;
  const message =
    (typeof structured === "string" && structured) ||
    structured?.message ||
    (typeof body === "string" && body.length < 500 ? body : null) ||
    `OmniRoute request failed with HTTP ${response.status}`;
  return new OmniRouteError(message, {
    status: response.status,
    code: structured?.code,
    requestId: response.headers.get("x-request-id") || undefined,
    details: structured,
  });
}

export class OmniRouteClient {
  #apiKey;
  #fetch;
  #baseUrl;
  #timeoutMs;

  constructor({
    baseUrl = "http://127.0.0.1:20128",
    apiKey,
    fetch: fetchImpl,
    timeoutMs = 30_000,
  } = {}) {
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length === 0)) {
      throw new TypeError("apiKey must be a non-empty string");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive number");
    }
    this.#baseUrl = stripVersionSuffix(baseUrl);
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = timeoutMs;
    if (typeof this.#fetch !== "function")
      throw new TypeError("A Fetch API implementation is required");
  }

  async requestRaw(path, options = {}) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\\\#\r\n]/.test(path) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|\?|$)/i.test(path)
    ) {
      throw new TypeError("path must be a gateway-relative path without traversal");
    }
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (this.#apiKey && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.#apiKey}`);
    }
    let body = options.body;
    if (body !== undefined && typeof body !== "string" && !(body instanceof FormData)) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(body);
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal,
      redirect: "error",
    });
    if (!response.ok) throw await readError(response);
    return response;
  }

  async request(path, options = {}) {
    const response = await this.requestRaw(path, options);
    if (response.status === 204) return null;
    return response.json();
  }

  capabilities() {
    return this.request("/v1/capabilities");
  }

  models(query = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    return this.request(`/v1/models${search.size ? `?${search}` : ""}`);
  }

  routingSignals(limit = 50) {
    return this.request(`/v1/explain/routing?limit=${encodeURIComponent(limit)}`);
  }

  health() {
    return this.request("/api/health/ping");
  }

  async chatCompletions(body, options = {}) {
    const response = await this.requestRaw("/v1/chat/completions", {
      method: "POST",
      body,
      headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return body?.stream ? response.body : response.json();
  }

  async responses(body, options = {}) {
    const response = await this.requestRaw("/v1/responses", {
      method: "POST",
      body,
      headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return body?.stream ? response.body : response.json();
  }

  createTask(task, { idempotencyKey, signal } = {}) {
    return this.request("/v1/tasks", {
      method: "POST",
      body: task,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      signal,
    });
  }

  listTasks(query = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    return this.request(`/v1/tasks${search.size ? `?${search}` : ""}`);
  }

  getTask(id) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}`);
  }

  claimTask(claim, options = {}) {
    return this.request("/v1/tasks/claim", {
      method: "POST",
      body: claim,
      signal: options.signal,
    });
  }

  heartbeatTask(id, leaseToken, leaseMs = 120_000) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}`, {
      method: "POST",
      body: { action: "heartbeat", leaseToken, leaseMs },
    });
  }

  completeTask(id, leaseToken, result) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}`, {
      method: "POST",
      body: { action: "complete", leaseToken, result },
    });
  }

  failTask(id, leaseToken, error, options = {}) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}`, {
      method: "POST",
      body: {
        action: "fail",
        leaseToken,
        error,
        retry: options.retry ?? true,
        retryDelayMs: options.retryDelayMs ?? 0,
      },
    });
  }

  cancelTask(id) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}`, {
      method: "POST",
      body: { action: "cancel" },
    });
  }

  taskEvents(id, afterSequence = 0) {
    return this.request(
      `/v1/tasks/${encodeURIComponent(id)}/events?afterSequence=${encodeURIComponent(afterSequence)}`
    );
  }
}
