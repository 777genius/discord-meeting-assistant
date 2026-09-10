import { FetchTransport, type HttpTransport } from "@infinity-context/sdk";

export interface InfinityContextRetrievalV2ExactExchange {
  readonly capabilityRequestBytes: Uint8Array;
  readonly capabilityResponseBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
}

export interface InfinityContextRetrievalV3ExactExchange extends InfinityContextRetrievalV2ExactExchange {
  readonly contractVersion: "context-retrieval.v3";
  readonly capabilityRoute: "/v1/context/retrieve-v3/capability";
  readonly retrievalRoute: "/v1/context/retrieve-v3";
}

type RetrievalContract = "context-retrieval.v2" | "context-retrieval.v3";

/** One sequential capability/retrieval operation at a time; consume even on SDK failure. */
export class ExactRetrievalExchangeTransport implements HttpTransport {
  readonly #delegate = new FetchTransport();
  readonly #contract: RetrievalContract;
  #sending = false;
  #capabilityExchange: {
    readonly origin: string;
    readonly capabilityRequestBytes: Uint8Array;
    readonly capabilityResponseBytes: Uint8Array;
  } | null = null;
  #exchange: InfinityContextRetrievalV2ExactExchange | null = null;

  public constructor(contract: RetrievalContract = "context-retrieval.v2") {
    if (contract !== "context-retrieval.v2" && contract !== "context-retrieval.v3") {
      throw new Error("Unsupported Infinity retrieval capture contract");
    }
    this.#contract = contract;
  }

  public async send(request: Parameters<HttpTransport["send"]>[0]) {
    // A rejected overlapping caller must not clear or consume the active owner's state.
    this.assertIdle();
    this.#sending = true;
    const capability = this.#capabilityExchange;
    this.#capabilityExchange = null;
    this.#exchange = null;
    try {
      const url = new URL(request.url.href);
      const capabilityRoute = this.#contract === "context-retrieval.v2"
        ? "/v1/capabilities" : "/v1/context/retrieve-v3/capability";
      const retrievalRoute = this.#contract === "context-retrieval.v2"
        ? "/v1/context/retrieve" : "/v1/context/retrieve-v3";
      // SDK buildUrl uses absolute /v1 paths: configured base-path prefixes are discarded.
      const isCapability = request.method === "GET" && url.pathname === capabilityRoute;
      const isRetrieval = request.method === "POST" && url.pathname === retrievalRoute;
      if ((!isCapability && !isRetrieval) || url.search !== "" || url.hash !== "" ||
        !["http:", "https:"].includes(url.protocol)) {
        throw new Error("Infinity retrieval capture method/route does not match selected contract");
      }
      if (isRetrieval && (capability === null || capability.origin !== url.origin)) {
        throw new Error("Infinity retrieval requires a fresh same-origin capability exchange");
      }
      const requestBytes = exactHttpBodyBytes(request.body);
      // Serialize once so the captured body and FetchTransport's body cannot diverge.
      // Keep raw bytes before the SDK's JSON/media/contract decoding, including invalid UTF-8.
      // Limits, cancellation and manual redirect handling remain owned by FetchTransport.
      const response = await this.#delegate.send({ ...request, url, body: capturedRequestBody(request, requestBytes),
        responseType: "bytes", requireJsonResponse: false });
      const responseBytes = typeof response.body === "string"
        ? new TextEncoder().encode(response.body) : new Uint8Array(response.body);
      if (isCapability && response.status >= 200 && response.status < 300) {
        this.#capabilityExchange = Object.freeze({ origin: url.origin,
          capabilityRequestBytes: requestBytes, capabilityResponseBytes: responseBytes });
      }
      if (isRetrieval && capability !== null) {
        this.#exchange = Object.freeze({ capabilityRequestBytes: capability.capabilityRequestBytes,
          capabilityResponseBytes: capability.capabilityResponseBytes, requestBytes, responseBytes });
      }
      return response;
    } finally {
      this.#sending = false;
    }
  }

  /** Legacy getter never returns a V3 artifact. */
  public takeRetrievalExchange(): InfinityContextRetrievalV2ExactExchange {
    const exchange = this.consumeExchange();
    if (this.#contract !== "context-retrieval.v2") {
      throw new Error("V3 capture requires takeRetrievalV3Exchange");
    }
    return exchange;
  }

  public takeRetrievalV3Exchange(): InfinityContextRetrievalV3ExactExchange {
    const exchange = this.consumeExchange();
    if (this.#contract !== "context-retrieval.v3") {
      throw new Error("V3 exchange requested from V2 capture");
    }
    return Object.freeze({ ...exchange, contractVersion: "context-retrieval.v3",
      capabilityRoute: "/v1/context/retrieve-v3/capability", retrievalRoute: "/v1/context/retrieve-v3" });
  }

  private consumeExchange(): InfinityContextRetrievalV2ExactExchange {
    this.assertIdle();
    const exchange = this.#exchange;
    this.#exchange = null;
    this.#capabilityExchange = null;
    if (exchange === null) {throw new Error("Infinity retrieval HTTP exchange was not captured");}
    return exchange;
  }

  private assertIdle(): void {
    if (this.#sending) {throw new Error("Overlapping Infinity retrieval capture operation");}
  }
}

function capturedRequestBody(request: Parameters<HttpTransport["send"]>[0], bytes: Uint8Array) {
  if (request.body === undefined) {return;}
  return { kind: "bytes" as const, value: new Uint8Array(bytes),
    contentType: request.body.kind === "json"
      ? request.headers.get("Content-Type") ?? "application/json" : request.body.contentType };
}

function exactHttpBodyBytes(body: Parameters<HttpTransport["send"]>[0]["body"]): Uint8Array {
  if (body === undefined) {return new Uint8Array();}
  if (body.kind === "json") {return new TextEncoder().encode(JSON.stringify(body.value));}
  if (typeof body.value === "string") {
    return new TextEncoder().encode(body.value);
  }
  if (body.value instanceof Uint8Array) {
    return new Uint8Array(body.value);
  }
  throw new Error("Infinity retrieval request body is not exact byte-addressable data");
}
