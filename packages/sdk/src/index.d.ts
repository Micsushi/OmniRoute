export const CONTRACT_VERSION: "1.0.0";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}
export interface TaskPolicy {
  filesystem?: "none" | "read-only" | "workspace-write";
  network?: "none" | "restricted";
  allowedHosts?: string[];
  commandProfile?: "none" | "restricted";
  maxRuntimeMs?: number;
  secretRefs?: string[];
}
export interface TaskInput {
  kind: string;
  payload?: Record<string, Json>;
  policy?: TaskPolicy;
  priority?: number;
  availableAt?: string;
  deadlineAt?: string;
  maxAttempts?: number;
}
export type TaskStatus = "queued" | "leased" | "cancelling" | "completed" | "failed" | "cancelled";
export interface AutomationTask extends TaskInput {
  id: string;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseStartedAt: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  traceId: string;
  result: Json;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface TaskEnvelope {
  object: "automation.task";
  apiVersion: "v1";
  data: AutomationTask;
  reused?: boolean;
  cancelRequested?: boolean;
}
export interface TaskEvent {
  sequence: number;
  taskId: string;
  type: string;
  data: Record<string, Json>;
  createdAt: string;
}
export interface ModelList {
  object?: "list";
  data: Array<{ id: string; capabilities?: Record<string, unknown>; [key: string]: unknown }>;
}
export class OmniRouteError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  details?: unknown;
  constructor(
    message: string,
    options?: { status?: number; code?: string; requestId?: string; details?: unknown }
  );
}
export class OmniRouteClient {
  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  });
  requestRaw(path: string, options?: RequestOptions): Promise<Response>;
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T | null>;
  capabilities(): Promise<Record<string, unknown>>;
  models(query?: Record<string, string | number | boolean>): Promise<ModelList>;
  routingSignals(limit?: number): Promise<Record<string, unknown>>;
  health(): Promise<unknown>;
  chatCompletions(
    body: Record<string, unknown> & { stream: true },
    options?: RequestOptions
  ): Promise<ReadableStream<Uint8Array>>;
  chatCompletions(body: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  responses(
    body: Record<string, unknown> & { stream: true },
    options?: RequestOptions
  ): Promise<ReadableStream<Uint8Array>>;
  responses(body: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  createTask(
    task: TaskInput,
    options?: Pick<RequestOptions, "idempotencyKey" | "signal">
  ): Promise<TaskEnvelope>;
  listTasks(query?: {
    status?: TaskStatus;
    limit?: number;
    after?: string;
  }): Promise<{ object: "list"; apiVersion: "v1"; data: AutomationTask[]; hasMore: boolean }>;
  getTask(id: string): Promise<TaskEnvelope>;
  claimTask(
    claim: { workerId: string; kinds?: string[]; leaseMs?: number },
    options?: Pick<RequestOptions, "signal">
  ): Promise<TaskEnvelope | null>;
  heartbeatTask(id: string, leaseToken: string, leaseMs?: number): Promise<TaskEnvelope>;
  completeTask(id: string, leaseToken: string, result?: Json): Promise<TaskEnvelope>;
  failTask(
    id: string,
    leaseToken: string,
    error: string,
    options?: { retry?: boolean; retryDelayMs?: number }
  ): Promise<TaskEnvelope>;
  cancelTask(id: string): Promise<TaskEnvelope>;
  taskEvents(
    id: string,
    afterSequence?: number
  ): Promise<{
    object: "list";
    apiVersion: "v1";
    taskId: string;
    data: TaskEvent[];
    hasMore: boolean;
  }>;
}
