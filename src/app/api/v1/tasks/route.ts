import {
  createAutomationTask,
  hashAutomationTaskRequest,
  listAutomationTasks,
  type AutomationTaskStatus,
} from "@/lib/db/automationTasks";
import {
  createAutomationTaskSchema,
  findInlineSecretKey,
} from "@/shared/validation/schemas/automationTasks";
import {
  authorizeTaskRequest,
  TASK_CORS_HEADERS,
  taskEnvelope,
  taskError,
  taskJson,
  safeTaskHandler,
  readTaskBody,
} from "./_shared";

const TASK_STATUSES = new Set<AutomationTaskStatus>([
  "queued",
  "leased",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export async function OPTIONS() {
  return new Response(null, { headers: TASK_CORS_HEADERS });
}

async function createTask(request: Request) {
  const auth = await authorizeTaskRequest(request);
  if (auth instanceof Response) return auth;
  const raw = await readTaskBody(request);
  const parsed = createAutomationTaskSchema.safeParse(raw);
  if (!parsed.success) return taskError(400, "invalid_task", "Task does not match the v1 schema");
  const inlineSecret = findInlineSecretKey(parsed.data.payload);
  if (inlineSecret) {
    return taskError(
      400,
      "inline_secret_rejected",
      "Inline secret-like field rejected; use policy.secretRefs"
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
  if (idempotencyKey && Buffer.byteLength(idempotencyKey) > 256) {
    return taskError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 256 bytes");
  }
  const requestHash = hashAutomationTaskRequest(parsed.data);
  const created = createAutomationTask({
    ownerId: auth.ownerId,
    idempotencyKey,
    requestHash,
    ...parsed.data,
  });
  if (created.conflict) {
    return taskError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used with a different task payload"
    );
  }
  return taskJson(
    created.reused ? 200 : 201,
    taskEnvelope(created.task, { reused: created.reused })
  );
}

async function listTasks(request: Request) {
  const auth = await authorizeTaskRequest(request);
  if (auth instanceof Response) return auth;
  const search = new URL(request.url).searchParams;
  const statusRaw = search.get("status");
  if (statusRaw && !TASK_STATUSES.has(statusRaw as AutomationTaskStatus)) {
    return taskError(400, "invalid_status", "Unknown task status");
  }
  const limitRaw = Number.parseInt(search.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
  const tasks = listAutomationTasks(auth.ownerId, {
    status: statusRaw as AutomationTaskStatus | undefined,
    after: search.get("after") || undefined,
    limit: limit + 1,
  });
  return taskJson(200, {
    object: "list",
    apiVersion: "v1",
    data: tasks.slice(0, limit),
    hasMore: tasks.length > limit,
  });
}

export const POST = safeTaskHandler(createTask);
export const GET = safeTaskHandler(listTasks);
