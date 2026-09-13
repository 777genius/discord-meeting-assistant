import { createHash } from "node:crypto";

export interface KnowledgeAnswerExchangeInventoryV2 {
  readonly schemaVersion: "discord_meeting.knowledge_answer_exchange_inventory.v2";
  readonly exchanges: readonly {
    readonly callOrdinal: "original" | "repair";
    readonly requestSha256: string;
    readonly responseSha256: string;
  }[];
}

interface KnowledgeAnswerExchangeBytes {
  readonly callOrdinal: "original" | "repair";
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
}

/** Authenticates exchange occurrence and each request/response boundary independently. */
export function knowledgeAnswerExchangeInventory(
  exchanges: readonly KnowledgeAnswerExchangeBytes[],
): KnowledgeAnswerExchangeInventoryV2 {
  if (exchanges.length > 2 || exchanges.some((exchange, index) =>
    exchange.callOrdinal !== (index === 0 ? "original" : "repair"))) {
    throw new Error("knowledge answer exchange inventory is unordered or invalid");
  }
  return Object.freeze({
    schemaVersion: "discord_meeting.knowledge_answer_exchange_inventory.v2",
    exchanges: Object.freeze(exchanges.map((exchange) => Object.freeze({
      callOrdinal: exchange.callOrdinal,
      requestSha256: createHash("sha256").update(exchange.requestBytes).digest("hex"),
      responseSha256: createHash("sha256").update(exchange.responseBytes).digest("hex"),
    }))),
  });
}

export function knowledgeAnswerExchangeInventorySha256(
  exchanges: readonly KnowledgeAnswerExchangeBytes[],
): string {
  return createHash("sha256").update(JSON.stringify(
    knowledgeAnswerExchangeInventory(exchanges)), "utf8").digest("hex");
}
