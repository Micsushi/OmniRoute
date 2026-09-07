import {
  cancelAutomationTask,
  getAutomationTask,
  heartbeatAutomationTask,
  settleAutomationTask,
} from "@/lib/db/automationTasks";
import { automationTaskActionSchema } from "@/shared/validation/schemas/automationTasks";
import {
  authorizeTaskRequest,
  TASK_CORS_HEADERS,
  taskEnvelope,
  taskError,
  taskJson,
  safeTaskHandler,
  readTaskBody,
} from "../_shared";

export async function OPTIONS() {
  return new Response(null, { headers: TASK_CORS_HEADERS });
}

async function getTask(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTaskRequest(request);
  if (auth instanceof Response) return auth;
  const task = getAutomationTask(auth.ownerId, (await params).id);
  return task
    ? taskJson(200, taskEnvelope(task))
    : taskError(404, "task_not_found", "Task not found");
}

async function updateTask(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTaskRequest(request);
  if (auth instanceof Response) return auth;
  const raw = await readTaskBody(request);
  const parsed = automationTaskActionSchema.safeParse(raw);
  if (!parsed.success)
    return taskError(400, "invalid_action", "Action does not match the v1 schema");
  const id = (await params).id;
  if (parsed.data.action === "cancel") {
    const task = cancelAutomationTask(auth.ownerId, id);
    return task
      ? taskJson(200, taskEnvelope(task))
      : taskError(404, "task_not_found", "Task not found");
  }
  if (parsed.data.action === "heartbeat") {
    const result = heartbeatAutomationTask({ ownerId: auth.ownerId, id, ...parsed.data });
    return result
      ? taskJson(200, taskEnvelope(result.task, { cancelRequested: result.cancelRequested }))
      : taskError(409, "stale_lease", "Lease is missing, expired, or fenced");
  }
  const task = settleAutomationTask({
    ownerId: auth.ownerId,
    id,
    leaseToken: parsed.data.leaseToken,
    outcome: parsed.data.action,
    ...(parsed.data.action === "complete"
      ? { result: parsed.data.result }
      : {
          error: parsed.data.error,
          retry: parsed.data.retry,
          retryDelayMs: parsed.data.retryDelayMs,
        }),
  });
  return task
    ? taskJson(200, taskEnvelope(task))
    : taskError(409, "stale_lease", "Lease is missing, expired, or fenced");
}

export const GET = safeTaskHandler(getTask);
export const POST = safeTaskHandler(updateTask);
