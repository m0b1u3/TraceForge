import { z } from "zod";
import { MODEL_PROTOCOLS } from "./model-protocol.js";

/** Declared compatibility, never execution permission or proof of model quality. */
export const ModelProfileSchema = z.object({
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().max(2048),
  protocol: z.enum(MODEL_PROTOCOLS),
  source: z.enum(["catalog", "documentation", "operator"]),
  contextWindowTokens: z.number().int().min(1024).max(100000000).optional(),
  maxOutputTokens: z.number().int().min(1).max(10000000).optional(),
  toolCalling: z.boolean().optional(),
  imageInput: z.boolean().optional(),
  documentInput: z.boolean().optional(),
  audioInput: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  adaptiveThinking: z.boolean().optional(),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export interface ModelCatalogEntry { id: string; profile?: ModelProfile }
