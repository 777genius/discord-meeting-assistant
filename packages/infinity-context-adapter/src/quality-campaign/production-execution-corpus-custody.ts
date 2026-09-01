import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, digest, exactRecord } from "./canonical.js";
import type { QualificationExecutionPacket } from
  "./execute-admitted-qualification-question.js";
import { validateQualificationExecutionPacket } from "./qualification-corpus-packets.js";

interface CorpusAuthority { readonly keyId: string; readonly publicKeyPem: string }

export async function loadProductionExecutionCorpus(input: {
  readonly authority: CorpusAuthority;
  readonly campaignRootSha256: string;
  readonly expectedQuestionCount: number;
  readonly executionPacketPath: string;
}): Promise<readonly QualificationExecutionPacket[]> {
  digest(input.campaignRootSha256, "execution corpus campaign root");
  const signed = await readSignedCorpusDocument(input.executionPacketPath, input.authority,
    "execution corpus");
  const payload = exactRecord(signed.payload, ["campaignRootSha256", "packets",
    "schemaVersion"], "execution corpus payload");
  if (payload.schemaVersion !== "meeting_knowledge.quality_execution_corpus.v1" ||
    payload.campaignRootSha256 !== input.campaignRootSha256 ||
    !Array.isArray(payload.packets) || payload.packets.length !== input.expectedQuestionCount) {
    throw new Error("execution corpus binding or cardinality is invalid");
  }
  const packets = payload.packets.map(validateQualificationExecutionPacket);
  if (new Set(packets.map(({ questionId }) => questionId)).size !== packets.length) {
    throw new Error("execution corpus question membership is duplicated");
  }
  return Object.freeze(packets);
}

export async function readSignedCorpusDocument(path: string, authority: CorpusAuthority,
  label: string) {
  if (!isAbsolute(path) || path.includes("\0") || authority.keyId.trim() === "") {
    throw new Error(`${label} custody configuration is invalid`);
  }
  const bytes = await readFile(resolve(path));
  const record = exactRecord(JSON.parse(bytes.toString("utf8")) as unknown,
    ["payload", "signatureBase64", "signerKeyId"], `${label} signed document`);
  if (record.signerKeyId !== authority.keyId || typeof record.signatureBase64 !== "string") {
    throw new Error(`${label} authority is invalid`);
  }
  let valid = false;
  try {valid = verify(null, Buffer.from(canonicalJson(record.payload)),
    createPublicKey(authority.publicKeyPem), Buffer.from(record.signatureBase64, "base64"));}
  catch {valid = false;}
  if (!valid) {throw new Error(`${label} signature is invalid`);}
  return Object.freeze({ payload: record.payload });
}
