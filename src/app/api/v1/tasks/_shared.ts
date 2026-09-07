import { createHash } from "node:crypto";

import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { CORS_HEADERS } from "@/shared/utils/cors";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/shared/middleware/bodySizeGuard";

export const TASK_CORS_HEADERS = {
  ...CORS_HEADERS,
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function taskJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { ...TASK_CORS_HEADERS, "Cache-Control": "no-store" },
  });
}

export async function readTaskBody(request: Request): Promise<unknown> {
  const bytes = await readRequestBodyWithLimit(request, 262_144);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function safeTaskHandler<T extends unknown[]>(handler: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return taskError(413, "body_too_large", "Task body exceeds 256 KiB");
      if (error instanceof SyntaxError)
        return taskError(400, "invalid_json", "Request body must be valid JSON");
      return taskError(500, "task_storage_error", "Task operation failed");
    }
  };
}

export function taskError(status: number, code: string, message: string): Response {
  return taskJson(status, buildErrorBody(status, message, null, { type: "task_error", code }));
}

export async function authorizeTaskRequest(
  request: Request
): Promise<{ ownerId: string } | Response> {
  const apiKey = extractApiKey(request);
  if (apiKey) {
    if (!(await isValidApiKey(apiKey))) {
      return taskError(401, "invalid_api_key", "Invalid API key");
    }
    const metadata = await getApiKeyMetadata(apiKey);
    const stableId = metadata?.id ?? createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
    return { ownerId: `api-key:${stableId}` };
  }
  if (await isDashboardSessionAuthenticated(request)) return { ownerId: "dashboard" };
  return taskError(401, "authentication_required", "Task storage always requires authentication");
}

export function taskEnvelope(task: unknown, extra: Record<string, unknown> = {}) {
  return { object: "automation.task", apiVersion: "v1", data: task, ...extra };
}
