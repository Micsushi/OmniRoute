import { listAutomationTaskEvents } from "@/lib/db/automationTasks";
import {
  authorizeTaskRequest,
  TASK_CORS_HEADERS,
  taskError,
  taskJson,
  safeTaskHandler,
} from "../../_shared";

export async function OPTIONS() {
  return new Response(null, { headers: TASK_CORS_HEADERS });
}

async function getEvents(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTaskRequest(request);
  if (auth instanceof Response) return auth;
  const id = (await params).id;
  const afterSequence = Number(new URL(request.url).searchParams.get("afterSequence") ?? 0);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
    return taskError(400, "invalid_cursor", "afterSequence must be a nonnegative integer");
  const events = listAutomationTaskEvents(auth.ownerId, id, afterSequence, 501);
  return events
    ? taskJson(200, {
        object: "list",
        apiVersion: "v1",
        taskId: id,
        data: events.slice(0, 500),
        hasMore: events.length > 500,
      })
    : taskError(404, "task_not_found", "Task not found");
}

export const GET = safeTaskHandler(getEvents);
