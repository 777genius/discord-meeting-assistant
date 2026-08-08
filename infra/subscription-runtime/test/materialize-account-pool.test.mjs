import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeAccountPool } from "../materialize-account-pool.mjs";

test("materializes an opaque immutable account-pool generation", async () => {
  await withFixture(async (fixture) => {
    const first = await materialize(fixture);
    const firstManifest = await readManifest(fixture.targetRoot);

    assert.equal(first.slots, 2);
    assert.equal(firstManifest.generation, first.generation);
    assert.deepEqual(firstManifest.slots.map((slot) => slot.id), [
      "slot-1",
      "slot-2",
    ]);
    assert.doesNotMatch(JSON.stringify(firstManifest), /account-a|account-b/u);
    assert.equal(
      await readFile(
        join(fixture.targetRoot, firstManifest.slots[0].authJsonPath),
        "utf8",
      ),
      '{"account":"a"}',
    );
    assert.equal(
      (await stat(join(
        fixture.targetRoot,
        firstManifest.slots[0].authJsonPath,
      ))).mode & 0o777,
      0o400,
    );

    const second = await materialize(fixture);
    const secondManifest = await readManifest(fixture.targetRoot);
    assert.notEqual(second.generation, first.generation);
    assert.equal(secondManifest.generation, second.generation);
    await assert.doesNotReject(readFile(join(
      fixture.targetRoot,
      "generations",
      first.generation,
      "slot-1",
      "auth.json",
    )));
  });
});

test("rejects a symlinked reserved auth artifact", async () => {
  await withFixture(async (fixture) => {
    const source = join(fixture.authRoot, "account-a", "auth.json");
    const moved = `${source}.real`;
    await writeFile(moved, await readFile(source), { mode: 0o600 });
    await rm(source);
    await symlink(moved, source);

    await assert.rejects(
      materialize(fixture),
      /reserved account auth is unsafe/u,
    );
  });
});

test("rejects a reservation manifest readable by another user", async () => {
  await withFixture(async (fixture) => {
    await chmod(fixture.reservationManifestPath, 0o640);

    await assert.rejects(
      materialize(fixture),
      /reservation manifest is unsafe/u,
    );
  });
});

async function withFixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "account-pool-test-")));
  try {
    const authRoot = join(root, "auth-root");
    const targetParent = join(root, "target");
    const targetRoot = join(targetParent, "auth-pool");
    const reservationManifestPath = join(root, "reservation.json");
    await Promise.all([
      mkdir(join(authRoot, "account-a"), { recursive: true }),
      mkdir(join(authRoot, "account-b"), { recursive: true }),
      mkdir(targetParent),
    ]);
    await Promise.all([
      writeFile(
        join(authRoot, "account-a", "auth.json"),
        '{"account":"a"}',
        { mode: 0o600 },
      ),
      writeFile(
        join(authRoot, "account-b", "auth.json"),
        '{"account":"b"}',
        { mode: 0o600 },
      ),
      writeFile(reservationManifestPath, JSON.stringify({
        accounts: ["account-a", "account-b"],
        owner: "discord-meeting-assistant",
        schemaVersion: 1,
      }), { mode: 0o600 }),
    ]);
    await Promise.all([
      chmod(join(authRoot, "account-a", "auth.json"), 0o600),
      chmod(join(authRoot, "account-b", "auth.json"), 0o600),
      chmod(reservationManifestPath, 0o600),
    ]);
    await run({
      authRoot,
      reservationManifestPath,
      targetRoot,
      targetUid: process.geteuid(),
      targetGid: process.getegid(),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function materialize(fixture) {
  return await materializeAccountPool(fixture);
}

async function readManifest(targetRoot) {
  return JSON.parse(await readFile(join(targetRoot, "pool.json"), "utf8"));
}
