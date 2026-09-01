import { FetchTransport, type HttpTransport } from "@infinity-context/sdk";

export interface InfinityContextRetrievalV2ExactExchange {
  readonly capabilityRequestBytes: Uint8Array;
  readonly capabilityResponseBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
}

export class ExactRetrievalExchangeTransport implements HttpTransport {
  readonly #delegate = new FetchTransport();
  #capabilityExchange: Pick<InfinityContextRetrievalV2ExactExchange,
    "capabilityRequestBytes" | "capabilityResponseBytes"> | null = null;
  #exchange: InfinityContextRetrievalV2ExactExchange | null = null;

  public async send(request: Parameters<HttpTransport["send"]>[0]) {
    const isCapability = request.method === "GET" &&
      request.url.pathname.endsWith("/capabilities");
    const isRetrieval = request.method === "POST" &&
      request.url.pathname.endsWith("/context/retrieve");
    const requestBytes = isCapability || isRetrieval ? exactHttpBodyBytes(request.body) : null;
    const response = await this.#delegate.send(request);
    const responseBytes = isCapability || isRetrieval
      ? typeof response.body === "string" ? new TextEncoder().encode(response.body)
        : new Uint8Array(response.body)
      : null;
    if (isCapability) {
      this.#capabilityExchange = Object.freeze({ capabilityRequestBytes: requestBytes!,
        capabilityResponseBytes: responseBytes! });
    }
    if (isRetrieval) {
      const capability = this.#capabilityExchange;
      if (capability === null) {
        throw new Error("Infinity capability exchange preceded retrieval capture");
      }
      this.#exchange = Object.freeze({ ...capability, requestBytes: requestBytes!,
        responseBytes: responseBytes! });
    }
    return response;
  }

  public takeRetrievalExchange(): InfinityContextRetrievalV2ExactExchange {
    const exchange = this.#exchange;
    this.#exchange = null;
    this.#capabilityExchange = null;
    if (exchange === null) {throw new Error("Infinity retrieval HTTP exchange was not captured");}
    return exchange;
  }
}

function exactHttpBodyBytes(body: Parameters<HttpTransport["send"]>[0]["body"]): Uint8Array {
  if (body === undefined) {return new Uint8Array();}
  if (body?.kind === "json") {return new TextEncoder().encode(JSON.stringify(body.value));}
  if (body?.kind === "bytes" && typeof body.value === "string") {
    return new TextEncoder().encode(body.value);
  }
  if (body?.kind === "bytes" && body.value instanceof Uint8Array) {
    return new Uint8Array(body.value);
  }
  throw new Error("Infinity retrieval request body is not exact byte-addressable data");
}
