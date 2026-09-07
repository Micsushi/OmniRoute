import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";

const CONTRACT_VERSION = "1.0.0";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function HEAD() {
  return new Response(null, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "X-Contract-Version": CONTRACT_VERSION,
    },
  });
}

export async function GET() {
  return Response.json(
    {
      object: "omniroute.capabilities",
      apiVersion: "v1",
      contractVersion: CONTRACT_VERSION,
      protocols: ["openai.chat", "openai.responses", "anthropic.messages", "a2a", "mcp"],
      discovery: {
        models: "/v1/models",
        modelCapabilitiesField: "capabilities",
        providerModels: "/v1/providers/{provider}/models",
      },
      routing: {
        policyEnforcement: true,
        fallback: true,
        circuitBreakers: true,
        budgetEnforcement: true,
        qualitySignals: "/v1/explain/routing",
        decisionReplay: "/api/routing/decisions/{requestId}",
      },
      compatibility: {
        streaming: ["sse", "websocket"],
        toolCalls: true,
        structuredErrors: "openai",
        idempotencyHeader: "Idempotency-Key",
        idempotencyScope: "task-submission",
      },
      automationTasks: {
        endpoint: "/v1/tasks",
        claim: "/v1/tasks/claim",
        leases: true,
        fencingTokens: true,
        cancellation: true,
        recovery: true,
        auditReplay: "/v1/tasks/{id}/events",
        secretRefs: "reference-only",
        sandboxPolicy: "worker-enforced",
        serverExecutesCommands: false,
        delivery: "at-least-once",
      },
      health: {
        liveness: "/api/health/ping",
        readiness: "/api/monitoring/health",
      },
    },
    { headers: { ...CORS_HEADERS, "X-Contract-Version": CONTRACT_VERSION } }
  );
}
