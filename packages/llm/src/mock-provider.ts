import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn } from "./provider.js";

type MockResult = unknown | ((args: ExtractJsonArgs) => unknown);

export class MockProvider implements LlmProvider {
  private turnIdx = 0;
  constructor(private result: MockResult, private turns: RunTurn[] = []) {}

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    return typeof this.result === "function"
      ? (this.result as (a: ExtractJsonArgs) => unknown)(args)
      : this.result;
  }

  async runTools(_args: RunToolsArgs): Promise<RunTurn> {
    const turn = this.turns[this.turnIdx];
    this.turnIdx += 1;
    return turn ?? { text: "", toolCalls: [], done: true };
  }
}
