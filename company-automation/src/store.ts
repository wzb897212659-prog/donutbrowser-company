import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentRecord } from "./model.js";

interface StoreDocument {
  schemaVersion: 1;
  environments: EnvironmentRecord[];
}

export class EnvironmentStore {
  readonly root: string;
  readonly profilesRoot: string;
  readonly screenshotsRoot: string;
  readonly statePath: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.profilesRoot = path.join(this.root, "profiles");
    this.screenshotsRoot = path.join(this.root, "screenshots");
    this.statePath = path.join(this.root, "environments.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.profilesRoot, { recursive: true });
    await mkdir(this.screenshotsRoot, { recursive: true });
  }

  async list(): Promise<EnvironmentRecord[]> {
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as unknown;
      if (!isStoreDocument(parsed)) throw new Error("本地环境索引格式无效");
      return parsed.environments;
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async put(record: EnvironmentRecord): Promise<void> {
    const records = await this.list();
    if (records.some((candidate) => candidate.id === record.id))
      throw new Error("环境已经存在");
    records.push(record);
    await this.write(records);
  }

  async delete(id: string): Promise<void> {
    const records = await this.list();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) throw new Error("环境不存在");
    await this.write(next);
    await rm(this.profilePath(id), { recursive: true, force: true });
  }

  profilePath(id: string): string {
    assertUuid(id);
    return path.join(this.profilesRoot, id);
  }

  private async write(environments: EnvironmentRecord[]): Promise<void> {
    const document: StoreDocument = { schemaVersion: 1, environments };
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isStoreDocument(value: unknown): value is StoreDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoreDocument>;
  return candidate.schemaVersion === 1 && Array.isArray(candidate.environments);
}
function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
export function assertUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("环境 ID 格式无效");
  }
}
