import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, safeId, sha256 } from "./canonical.js";
import { SemanticQualityV4EncryptedArtifactStore } from "./canonical-execution-evidence-store.js";
import type { SemanticQualityV4ArtifactReceipt } from "./canonical-execution-artifact-validation.js";
/** Authenticated create-only diagnostic data; names and reservations contain no question text. */
export class DiagnosticCustody {
  readonly #artifacts: SemanticQualityV4EncryptedArtifactStore;
  public constructor(readonly root: string, readonly key: Uint8Array, readonly bindingSha256: string) {
    this.#artifacts = new SemanticQualityV4EncryptedArtifactStore(join(root, "encrypted"));
  }
  public async reserve(id: string, payload: unknown): Promise<void> {
    await this.write(`${safeId(id, "reservation")}.reserved.json`, { bindingSha256: this.bindingSha256, payloadSha256: sha256(payload) });
  }
  public async reserved(id: string): Promise<boolean> {
    return (await this.read(`${safeId(id, "reservation")}.reserved.json`)) !== null;
  }
  public async retain(id: string, value: unknown): Promise<void> {
    safeId(id, "artifact");
    const receipt = await this.#artifacts.sealCreateOnly({
      artifactKind: "evidence", attemptId: `sqv4-${sha256({ root: this.bindingSha256, id })}`,
      key: this.key, keyId: "diagnostic", rootBindingSha256: this.bindingSha256,
      plaintext: Buffer.from(canonicalJson(value)),
    });
    await this.write(`${id}.receipt.json`, receipt);
  }
  public async recover<T>(id: string): Promise<T | null> {
    const receipt = await this.read(`${safeId(id, "artifact")}.receipt.json`);
    if (receipt === null) {
      return null;
    }
    const r = receipt as SemanticQualityV4ArtifactReceipt;
    if (r.rootBindingSha256 !== this.bindingSha256 ||
      r.attemptId !== `sqv4-${sha256({ root: this.bindingSha256, id })}` || r.artifactKind !== "evidence") {
      throw new Error("foreign diagnostic artifact");
    }
    const bytes = await this.#artifacts.openReceipt({ key: this.key, receipt: r });
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  }
  private async read(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.root, name), "utf8")) as unknown;
    }
    catch (error) {
      if ((error as {
        code?: string;
      }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  private async write(name: string, value: unknown): Promise<void> {
    const firstCreated = await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (firstCreated !== undefined) {
      const stop = dirname(resolve(firstCreated));
      let directoryPath: string | undefined = resolve(this.root);
      while (directoryPath !== undefined) {
        const directory = await open(directoryPath, "r");
        try {
          await directory.sync();
        }
        finally {
          await directory.close();
        }
        directoryPath = directoryPath === stop ? undefined : dirname(directoryPath);
      }
    }
    const file = await open(join(this.root, name), "wx", 0o600);
    try {
      await file.writeFile(canonicalJson(value));
      await file.sync();
    }
    finally {
      await file.close();
    }
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    }
    finally {
      await directory.close();
    }
  }
}
