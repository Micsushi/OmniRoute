import { claimAutomationTask } from "@/lib/db/automationTasks";
import { claimAutomationTaskSchema } from "@/shared/validation/schemas/automationTasks";
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

async function claimTask(request: Request) {
  const auth = await authorizeTaskRequest(request);
  if (auth instanceof Response) return auth;
  const raw = await readTaskBody(request);
  const parsed = claimAutomationTaskSchema.safeParse(raw);
  if (!parsed.success) return taskError(400, "invalid_claim", "Claim does not match the v1 schema");
  const task = claimAutomationTask({ ownerId: auth.ownerId, ...parsed.data });
  return task
    ? taskJson(200, taskEnvelope(task))
    : new Response(null, { status: 204, headers: TASK_CORS_HEADERS });
}

export const POST = safeTaskHandler(claimTask);
