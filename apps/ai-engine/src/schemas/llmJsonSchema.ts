import { ACTION_TYPES, PAYMENT_BEHAVIORS, PRIORITIES, SEVERITIES } from "@aegis/contracts-ai";

/**
 * JSON Schema handed to Ollama (`format`) so decoding is constrained to the required shape.
 * Hand-written on purpose: only keywords every Ollama/llama.cpp version supports.
 * The authoritative validation is the strict Zod schema (LlmAnalysisOutputSchema) + EvidenceValidator.
 */
export const LLM_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "customerSituation", "signals", "recommendedAction", "confidence", "uncertainties", "nextBestStep"],
  properties: {
    summary: { type: "string" },
    customerSituation: {
      type: "object",
      additionalProperties: false,
      required: ["segment", "paymentBehavior"],
      properties: {
        segment: { type: "string" },
        paymentBehavior: { type: "string", enum: [...PAYMENT_BEHAVIORS] },
      },
    },
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "evidenceIds", "explanation"],
        properties: {
          code: { type: "string" },
          severity: { type: "string", enum: [...SEVERITIES] },
          evidenceIds: { type: "array", items: { type: "string" } },
          explanation: { type: "string" },
        },
      },
    },
    recommendedAction: {
      type: "object",
      additionalProperties: false,
      required: ["type", "priority", "reason", "evidenceIds"],
      properties: {
        type: { type: "string", enum: [...ACTION_TYPES] },
        priority: { type: "string", enum: [...PRIORITIES] },
        reason: { type: "string" },
        evidenceIds: { type: "array", items: { type: "string" } },
      },
    },
    confidence: { type: "number" },
    uncertainties: { type: "array", items: { type: "string" } },
    nextBestStep: { type: "string" },
  },
};
