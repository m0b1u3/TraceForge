import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkerCheckpointDocument, WorkerCheckpointStore } from "./model.js";

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class JsonFileCheckpointStore implements WorkerCheckpointStore {
  constructor(private readonly root: string) {}

  async save(document: WorkerCheckpointDocument): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const name = `${safeId(document.runId)}-${safeId(document.workId)}.json`;
    const target = resolve(this.root, name);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(document), "utf8");
    await rename(temporary, target);
    return `checkpoint://${name}`;
  }

  async load(ref: string): Promise<WorkerCheckpointDocument> {
    if (!ref.startsWith("checkpoint://")) throw new Error(`Unsupported checkpoint reference ${ref}`);
    const name = ref.slice("checkpoint://".length);
    if (!name || safeId(name) !== name) throw new Error(`Unsafe checkpoint reference ${ref}`);
    const document = JSON.parse(await readFile(resolve(this.root, name), "utf8")) as WorkerCheckpointDocument;
    if (document.version !== 1) throw new Error(`Unsupported checkpoint version ${String(document.version)}`);
    return document;
  }
}
