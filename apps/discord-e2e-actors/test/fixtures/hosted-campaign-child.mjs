import { constants } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const [rootPath, childId, behavior = "ack"] = process.argv.slice(2);
if (rootPath === undefined || childId === undefined) {
  throw new Error("sandbox fixture requires a root path and child ID");
}

async function writeCreateOnly(path, contents) {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

await writeCreateOnly(join(rootPath, `ready-${childId}`), `${childId}\n`);

const handled = new Set();
while (true) {
  const names = (await readdir(rootPath))
    .filter((name) => name.endsWith(`-${childId}-command`))
    .toSorted();
  for (const name of names) {
    if (handled.has(name)) {
      continue;
    }
    handled.add(name);
    if (behavior === "exit") {
      process.exit(23);
    }
    if (behavior === "hang") {
      continue;
    }

    const command = JSON.parse(await readFile(join(rootPath, name), "utf8"));
    if (command.sourcePath !== undefined && command.outputPath !== undefined) {
      await writeCreateOnly(command.outputPath, await readFile(command.sourcePath, "utf8"));
    }
    await writeCreateOnly(
      join(rootPath, name.replace(/-command$/u, "-ack")),
      `${JSON.stringify({ action: command.action, childId })}\n`,
    );
  }
  await new Promise((resolve) => { setTimeout(resolve, 5); });
}
