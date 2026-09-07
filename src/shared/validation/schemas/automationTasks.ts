import { z } from "zod";

const isoDate = z.string().datetime({ offset: true });

export const automationTaskPolicySchema = z
  .object({
    filesystem: z.enum(["none", "read-only", "workspace-write"]).default("none"),
    network: z.enum(["none", "restricted"]).default("none"),
    allowedHosts: z.array(z.string().trim().min(1).max(253)).max(64).default([]),
    commandProfile: z.enum(["none", "restricted"]).default("none"),
    maxRuntimeMs: z.number().int().min(1_000).max(86_400_000).default(900_000),
    secretRefs: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/))
      .max(32)
      .default([]),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.network === "none" && policy.allowedHosts.length > 0) {
      context.addIssue({
        code: "custom",
        message: "allowedHosts requires network=restricted",
        path: ["allowedHosts"],
      });
    }
  });

export const createAutomationTaskSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/),
    payload: z.record(z.string(), z.unknown()).default({}),
    policy: automationTaskPolicySchema.prefault({}),
    priority: z.number().int().min(-100).max(100).default(0),
    availableAt: isoDate.optional(),
    deadlineAt: isoDate.optional(),
    maxAttempts: z.number().int().min(1).max(20).default(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.availableAt &&
      value.deadlineAt &&
      Date.parse(value.deadlineAt) <= Date.parse(value.availableAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "deadlineAt must be after availableAt",
        path: ["deadlineAt"],
      });
    }
  });

export const claimAutomationTaskSchema = z
  .object({
    workerId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    kinds: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/)
      )
      .max(32)
      .optional(),
    leaseMs: z.number().int().min(5_000).max(1_800_000).default(120_000),
  })
  .strict();

export const automationTaskActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("heartbeat"),
    leaseToken: z.string().uuid(),
    leaseMs: z.number().int().min(5_000).max(1_800_000).default(120_000),
  }),
  z.object({
    action: z.literal("complete"),
    leaseToken: z.string().uuid(),
    result: z.unknown().optional(),
  }),
  z.object({
    action: z.literal("fail"),
    leaseToken: z.string().uuid(),
    error: z.string().trim().min(1).max(2_000),
    retry: z.boolean().default(true),
    retryDelayMs: z.number().int().min(0).max(86_400_000).default(0),
  }),
  z.object({ action: z.literal("cancel") }),
]);

const SENSITIVE_KEY =
  /(^|_)(api_?key|authorization|credential|password|passwd|secret|access_?token|refresh_?token)($|_)/i;

export function findInlineSecretKey(value: unknown, path = "payload", depth = 0): string | null {
  if (depth > 64) return path;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findInlineSecretKey(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = `${path}.${key}`;
    if (SENSITIVE_KEY.test(key)) return nestedPath;
    const found = findInlineSecretKey(nested, nestedPath, depth + 1);
    if (found) return found;
  }
  return null;
}
