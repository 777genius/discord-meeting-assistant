#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const maximumAccounts = 8;
const reservationOwner = "discord-meeting-assistant";

export async function materializeAccountPool(options) {
  const authRoot = await canonicalDirectory(options.authRoot, "auth root");
  const reservationManifestPath = await canonicalPrivateFile(
    options.reservationManifestPath,
    "reservation manifest",
  );
  const reservation = reservationManifest(
    JSON.parse(await readFile(reservationManifestPath, "utf8")),
  );
  const targetParent = await canonicalDirectory(
    dirname(options.targetRoot),
    "target parent",
  );
  const targetRoot = resolve(options.targetRoot);
  if (
    !targetRoot.startsWith(`${targetParent}${sep}`) ||
    targetRoot === authRoot ||
    targetRoot.startsWith(`${authRoot}${sep}`)
  ) {
    throw new Error("account-pool-error: target root escapes its parent");
  }
  await ensurePrivateDirectory(
    targetRoot,
    options.targetUid,
    options.targetGid,
  );
  const generationsRoot = join(targetRoot, "generations");
  await ensurePrivateDirectory(
    generationsRoot,
    options.targetUid,
    options.targetGid,
  );
  const generation = randomBytes(16).toString("hex");
  const generationRoot = join(generationsRoot, generation);
  await ensurePrivateDirectory(
    generationRoot,
    options.targetUid,
    options.targetGid,
  );

  const slots = [];
  for (const [index, accountName] of reservation.accounts.entries()) {
    const sourceDirectory = join(authRoot, accountName);
    if (
      (await realpath(sourceDirectory).catch(() => "")) !== sourceDirectory
    ) {
      throw new Error("account-pool-error: reserved account directory is unsafe");
    }
    const sourceAuthPath = await canonicalPrivateFile(
      join(sourceDirectory, "auth.json"),
      "reserved account auth",
    );
    const authBytes = await readFile(sourceAuthPath);
    if (authBytes.byteLength === 0 || authBytes.byteLength > 1024 * 1024) {
      throw new Error("account-pool-error: reserved account auth size is invalid");
    }
    assertJsonObject(authBytes);
    const id = `slot-${index + 1}`;
    const slotRoot = join(generationRoot, id);
    await ensurePrivateDirectory(
      slotRoot,
      options.targetUid,
      options.targetGid,
    );
    const targetAuthPath = join(slotRoot, "auth.json");
    await writeFile(targetAuthPath, authBytes, { flag: "wx", mode: 0o400 });
    await chown(targetAuthPath, options.targetUid, options.targetGid);
    await chmod(targetAuthPath, 0o400);
    slots.push({
      authJsonPath: `generations/${generation}/${id}/auth.json`,
      id,
    });
  }

  const nextManifestPath = join(targetRoot, `pool.json.next-${generation}`);
  await writeFile(nextManifestPath, `${JSON.stringify({
    generation,
    schemaVersion: 1,
    slots,
  })}\n`, { flag: "wx", mode: 0o400 });
  await chown(nextManifestPath, options.targetUid, options.targetGid);
  await chmod(nextManifestPath, 0o400);
  await rename(nextManifestPath, join(targetRoot, "pool.json"));
  return { generation, slots: slots.length };
}

function reservationManifest(value) {
  if (!isRecord(value)) {
    throw new Error("account-pool-error: reservation manifest is invalid");
  }
  const keys = Object.keys(value).toSorted();
  if (
    JSON.stringify(keys) !== JSON.stringify(["accounts", "owner", "schemaVersion"]) ||
    value.schemaVersion !== 1 ||
    value.owner !== reservationOwner ||
    !Array.isArray(value.accounts) ||
    value.accounts.length < 1 ||
    value.accounts.length > maximumAccounts ||
    !value.accounts.every(
      (account) =>
        typeof account === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(account),
    ) ||
    new Set(value.accounts).size !== value.accounts.length
  ) {
    throw new Error("account-pool-error: reservation manifest is invalid");
  }
  return value;
}

async function canonicalDirectory(path, label) {
  const absolute = resolve(path);
  const pathStat = await lstat(absolute).catch(() => null);
  if (
    pathStat === null ||
    !pathStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error(`account-pool-error: ${label} is unsafe`);
  }
  return absolute;
}

async function canonicalPrivateFile(path, label) {
  const absolute = resolve(path);
  const pathStat = await lstat(absolute).catch(() => null);
  if (
    pathStat === null ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    (pathStat.mode & 0o077) !== 0 ||
    pathStat.uid !== process.geteuid() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error(`account-pool-error: ${label} is unsafe`);
  }
  return absolute;
}

async function ensurePrivateDirectory(path, uid, gid) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const canonical = await canonicalDirectory(path, "target directory");
  if (canonical !== path) {
    throw new Error("account-pool-error: target directory is not canonical");
  }
  await chown(path, uid, gid);
  await chmod(path, 0o700);
}

function assertJsonObject(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("account-pool-error: reserved account auth is malformed");
  }
  if (!isRecord(parsed)) {
    throw new Error("account-pool-error: reserved account auth is malformed");
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
  const values = new Map();
  const allowedKeys = new Set([
    "--auth-root",
    "--reservation-manifest",
    "--target-gid",
    "--target-root",
    "--target-uid",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key?.startsWith("--") ||
      !allowedKeys.has(key) ||
      value === undefined ||
      values.has(key)
    ) {
      throw new Error("account-pool-error: invalid arguments");
    }
    values.set(key, value);
  }
  if (values.size !== allowedKeys.size) {
    throw new Error("account-pool-error: required argument is missing");
  }
  const required = (key) => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) {
      throw new Error("account-pool-error: required argument is missing");
    }
    return value;
  };
  const integer = (key) => {
    const value = Number(required(key));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("account-pool-error: numeric argument is invalid");
    }
    return value;
  };
  return {
    authRoot: required("--auth-root"),
    reservationManifestPath: required("--reservation-manifest"),
    targetGid: integer("--target-gid"),
    targetRoot: required("--target-root"),
    targetUid: integer("--target-uid"),
  };
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  materializeAccountPool(parseArguments(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`materialized ${result.slots} subscription account slots\n`);
      return result.slots;
    })
    .catch((error) => {
      const message = error instanceof Error
        ? error.message.replaceAll(/[\r\n]+/gu, " ").slice(0, 500)
        : "account-pool-error: unknown failure";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
