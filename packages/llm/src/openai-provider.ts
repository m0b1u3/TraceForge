import OpenAI from "openai";
import type { LlmProvider, ExtractJsonArgs } from "./provider.js";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class OpenAICompatibleProvider implements LlmProvider {
  private client: OpenAI;
  constructor(private opts: OpenAIOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  }

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema: args.schema },
      },
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error("no content in response");
    return JSON.parse(content);
  }
}
