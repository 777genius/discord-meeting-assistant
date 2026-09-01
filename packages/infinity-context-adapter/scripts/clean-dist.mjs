import { rm } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
if (dist.pathname.split("/").at(-2) !== "dist") {
  throw new Error("refusing to clean an unresolved build output");
}
await rm(dist, { force: true, recursive: true });
