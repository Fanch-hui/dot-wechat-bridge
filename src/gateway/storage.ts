import { mkdir, open, readFile, rename, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, JobResult } from "../shared/contracts.ts";

export interface Credentials { botToken: string; botId: string; userId: string; baseUrl: string }
export interface JournalData {
  gatewayId: string;
  pending?: { previous_cursor: string; cursor: string; messages: IncomingMessage[] };
  jobs: Record<string, { claimToken: string; kind: "reply" | "webhook"; participantId?: string; started?: boolean; result?: JobResult }>;
}

export async function readPrivateJson<T>(path: string): Promise<T> {
  await chmod(path, 0o600);
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export class Journal {
  private writing = Promise.resolve();
  constructor(readonly path: string, readonly data: JournalData) {}
  static async load(path: string): Promise<Journal> {
    try { return new Journal(path, await readPrivateJson<JournalData>(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const journal = new Journal(path, { gatewayId: randomUUID(), jobs: {} });
      await journal.save();
      return journal;
    }
  }
  save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    const write = this.writing.then(() => atomicPrivateJson(this.path, snapshot));
    this.writing = write.catch(() => {});
    return write;
  }
}
