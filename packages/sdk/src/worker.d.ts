import type { OmniRouteClient, TaskEnvelope } from "./index.js";
export function runChatTaskOnce(
  client: OmniRouteClient,
  options: { workerId: string; model: string; signal?: AbortSignal }
): Promise<TaskEnvelope | null>;
