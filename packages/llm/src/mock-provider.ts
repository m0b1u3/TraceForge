import type { LlmProvider, ExtractJsonArgs } from "./provider.js";

type MockResult = unknown | ((args: ExtractJsonArgs) => unknown);

export class MockProvider implements LlmProvider {
  constructor(private result: MockResult) {}

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    return typeof this.result === "function"
      ? (this.result as (a: ExtractJsonArgs) => unknown)(args)
      : this.result;
  }
}
