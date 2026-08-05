export async function captureBridgeOutput(run) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(toBuffer(chunk, encoding));
    const completion = typeof encoding === "function" ? encoding : callback;
    if (typeof completion === "function") {
      queueMicrotask(completion);
    }
    return true;
  };
  try {
    return {
      exitCode: await run(),
      output: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
}
