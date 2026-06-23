export interface ExtractJsonArgs {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

export interface LlmProvider {
  extractJson(args: ExtractJsonArgs): Promise<unknown>;
}
