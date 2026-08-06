import { constants, open } from "node:fs/promises";

const maximumSecretFileSizeBytes = 65_536;
const invalidSecretPathMessage = "Secret path must be a small regular non-symlink file";

export async function readSecretFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error(invalidSecretPathMessage, { cause: error });
    }
    throw error;
  }

  try {
    const descriptor = await handle.stat();
    if (
      !descriptor.isFile() ||
      descriptor.size > maximumSecretFileSizeBytes
    ) {
      throw new Error(invalidSecretPathMessage);
    }
    const content = await handle.readFile();
    if (content.byteLength > maximumSecretFileSizeBytes) {
      throw new Error(invalidSecretPathMessage);
    }
    const value = content.toString("utf8").trim();
    if (value.length === 0 || value.includes("\0")) {
      throw new Error("Secret file must contain a non-empty text value");
    }
    return value;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
