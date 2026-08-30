import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** 保存“Router 已接收，但 Fusion 目录尚未完成发布”的非敏感恢复标记。 */
export class ConnectionPublicationState {
  constructor({ stateRoot } = {}) {
    if (!path.isAbsolute(stateRoot)) throw new Error("connection_publication_state_invalid");
    this.filePath = path.join(path.resolve(stateRoot), "connection-publication.json");
  }

  async isPending() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      return value?.schemaVersion === 1 && value.pending === true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async markPending() {
    if (await this.isPending()) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.new-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, pending: true })}\n`, {
      flag: "wx",
    });
    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async clear() {
    await unlink(this.filePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
