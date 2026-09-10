import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, InfinityContextClient, type HttpTransport } from "@infinity-context/sdk";
import { ExactRetrievalExchangeTransport } from "../src/infinity-context-retrieval-exchange.js";

type Request = Parameters<HttpTransport["send"]>[0];
const routes = {
  "context-retrieval.v2": ["/v1/capabilities", "/v1/context/retrieve"],
  "context-retrieval.v3": ["/v1/context/retrieve-v3/capability", "/v1/context/retrieve-v3"],
} as const;
const bytes = (text: string) => new TextEncoder().encode(text);
const request = (path: string, method: Request["method"] = "GET", origin = "https://memory.test"): Request => ({
  method, url: new URL(path, origin), headers: new Headers(),
  ...(method === "POST" ? { body: { kind: "json" as const, value: { query: "café" } } } : {}),
});
function mockFetch() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
    new Response(' { "synthetic": true }\n', { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe("exact retrieval exchange capture", () => {
  it("preserves default V2 callers and the SDK's absolute routes with a base path", async () => {
    const fetch = mockFetch();
    const transport = new ExactRetrievalExchangeTransport();
    const client = new InfinityContextClient({ baseUrl: "https://memory.test/proxy/base", transport,
      retryPolicy: { maxAttempts: 1 } });
    await client.system.capabilities();
    await transport.send(request(routes["context-retrieval.v2"][1], "POST"));
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://memory.test/v1/capabilities");
    const exchange = transport.takeRetrievalExchange();
    expect(Object.keys(exchange).toSorted()).toEqual([
      "capabilityRequestBytes", "capabilityResponseBytes", "requestBytes", "responseBytes",
    ]);
    expect(exchange.capabilityRequestBytes).toEqual(new Uint8Array());
    expect(exchange.requestBytes).toEqual(bytes('{"query":"café"}'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  for (const contract of ["context-retrieval.v2", "context-retrieval.v3"] as const) {
    const [capability, retrieval] = routes[contract];
    const take = (transport: ExactRetrievalExchangeTransport) => contract === "context-retrieval.v2"
      ? transport.takeRetrievalExchange() : transport.takeRetrievalV3Exchange();

    it(`${contract}: retains byte identity, including malformed UTF-8, without decoding`, async () => {
      const fetch = mockFetch();
      const capabilityBytes = bytes(' {"contract_version":"synthetic"}\n');
      const responseBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 10]);
      fetch.mockResolvedValueOnce(new Response(capabilityBytes)).mockResolvedValueOnce(new Response(responseBytes));
      const transport = new ExactRetrievalExchangeTransport(contract);
      await transport.send(request(capability));
      const response = await transport.send(request(retrieval, "POST"));
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(response.body as Uint8Array)).toThrow();
      (response.body as Uint8Array).fill(0);
      const exchange = take(transport);
      expect(exchange.capabilityResponseBytes).toEqual(capabilityBytes);
      expect(exchange.responseBytes).toEqual(responseBytes);
      expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([capability, retrieval]);
      expect(fetch.mock.calls[1]?.[1]?.body).toEqual(exchange.requestBytes);
      if (contract === "context-retrieval.v3") {
        expect(exchange).toMatchObject({ contractVersion: contract, capabilityRoute: capability, retrievalRoute: retrieval });
      }
      expect(() => take(transport)).toThrow(/not captured/u);
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it(`${contract}: captures before actual SDK JSON/media decoding fails`, async () => {
      const fetch = mockFetch();
      const transport = new ExactRetrievalExchangeTransport(contract);
      const client = new HttpClient({ baseUrl: "https://memory.test/prefix", transport,
        retryPolicy: { maxAttempts: 1 } });
      for (const malformed of [new Uint8Array([0xff]), bytes('{"broken":'), bytes('{}')]) {
        await client.request({ method: "GET", path: capability });
        fetch.mockResolvedValueOnce(new Response(malformed, { headers: {
          "content-type": malformed.length === 2 ? "text/plain" : "application/json",
        } }));
        await expect(client.request({ method: "POST", path: retrieval, json: { query: "synthetic" } })).rejects.toThrow();
        expect(take(transport).responseBytes).toEqual(malformed);
      }
      expect(fetch).toHaveBeenCalledTimes(6);
    });

    it(`${contract}: rejects missing, consumed and cross-origin pairs before POST`, async () => {
      const fetch = mockFetch();
      const transport = new ExactRetrievalExchangeTransport(contract);
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      await transport.send(request(capability));
      await expect(transport.send(request(retrieval, "POST", "https://foreign.test"))).rejects.toThrow(/same-origin/u);
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      await transport.send(request(capability));
      expect(() => take(transport)).toThrow(/not captured/u);
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it(`${contract}: clears successful and pending captures on network failures`, async () => {
      const fetch = mockFetch();
      const transport = new ExactRetrievalExchangeTransport(contract);
      await transport.send(request(capability));
      await transport.send(request(retrieval, "POST"));
      fetch.mockRejectedValueOnce(new Error("synthetic network failure"));
      await expect(transport.send(request(capability))).rejects.toThrow();
      expect(() => take(transport)).toThrow(/not captured/u);
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      await transport.send(request(capability));
      fetch.mockRejectedValueOnce(new Error("synthetic retrieval failure"));
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow();
      expect(() => take(transport)).toThrow(/not captured/u);
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it(`${contract}: rejects wrong methods, versions, suffix collisions and query routes`, async () => {
      const fetch = mockFetch();
      const transport = new ExactRetrievalExchangeTransport(contract);
      const other = routes[contract === "context-retrieval.v2" ? "context-retrieval.v3" : "context-retrieval.v2"];
      for (const invalid of [request(other[0]), request(other[1], "POST"), request(`/proxy${capability}`),
        request(`/proxy${retrieval}`, "POST"), request(capability, "POST"), request(retrieval),
        request(`${retrieval}?extra=1`, "POST"), request(`${retrieval}/`, "POST"), request(`${retrieval}#fragment`, "POST")]) {
        await transport.send(request(capability));
        await expect(transport.send(invalid)).rejects.toThrow(/method\/route/u);
        await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      }
      expect(fetch).toHaveBeenCalledTimes(9);
    });

    it(`${contract}: rejects overlap and consumption during sends without corrupting the owner`, async () => {
      const fetch = mockFetch();
      const transport = new ExactRetrievalExchangeTransport(contract);
      for (const path of [capability, retrieval]) {
        let release!: (response: Response) => void;
        fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        const sending = transport.send(request(path, path === capability ? "GET" : "POST"));
        await expect(transport.send(request(capability))).rejects.toThrow(/Overlapping/u);
        expect(() => take(transport)).toThrow(/Overlapping/u);
        release(new Response(bytes(path)));
        await sending;
      }
      const exchange = take(transport);
      expect(exchange.capabilityResponseBytes).toEqual(bytes(capability));
      expect(exchange.responseBytes).toEqual(bytes(retrieval));
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it(`${contract}: failed capability status cannot authorize retrieval; failed retrieval bytes survive`, async () => {
      const fetch = mockFetch();
      const transport = new ExactRetrievalExchangeTransport(contract);
      fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
      await transport.send(request(capability));
      await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
      await transport.send(request(capability));
      fetch.mockResolvedValueOnce(new Response("failed retrieval", { status: 500 }));
      await transport.send(request(retrieval, "POST"));
      expect(take(transport).responseBytes).toEqual(bytes("failed retrieval"));
      expect(fetch).toHaveBeenCalledTimes(3);
    });
  }

  it("clears unconsumed success before invalid routes and unaddressable request bodies", async () => {
    const fetch = mockFetch();
    const transport = new ExactRetrievalExchangeTransport();
    const [capability, retrieval] = routes["context-retrieval.v2"];
    await transport.send(request(capability));
    await transport.send(request(retrieval, "POST"));
    await expect(transport.send(request("/unrelated"))).rejects.toThrow(/method\/route/u);
    expect(() => transport.takeRetrievalExchange()).toThrow(/not captured/u);
    await transport.send(request(capability));
    await expect(transport.send({ ...request(retrieval, "POST"),
      body: { kind: "bytes", value: new Blob(["synthetic"]) } })).rejects.toThrow(/byte-addressable/u);
    await expect(transport.send(request(retrieval, "POST"))).rejects.toThrow(/fresh/u);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("a new capability replaces both an old completed exchange and pending capability bytes", async () => {
    const fetch = mockFetch();
    const transport = new ExactRetrievalExchangeTransport();
    const [capability, retrieval] = routes["context-retrieval.v2"];
    await transport.send(request(capability));
    await transport.send(request(retrieval, "POST"));
    fetch.mockResolvedValueOnce(new Response("new capability"));
    await transport.send(request(capability));
    await transport.send(request(retrieval, "POST"));
    expect(transport.takeRetrievalExchange().capabilityResponseBytes).toEqual(bytes("new capability"));
    await transport.send(request(capability));
    fetch.mockResolvedValueOnce(new Response("latest capability"));
    await transport.send(request(capability));
    await transport.send(request(retrieval, "POST"));
    expect(transport.takeRetrievalExchange().capabilityResponseBytes).toEqual(bytes("latest capability"));
  });

  it("never exposes a V3 exchange through the V2 getter or relabels V2 as V3", async () => {
    mockFetch();
    for (const contract of ["context-retrieval.v2", "context-retrieval.v3"] as const) {
      const transport = new ExactRetrievalExchangeTransport(contract);
      await transport.send(request(routes[contract][0]));
      await transport.send(request(routes[contract][1], "POST"));
      expect(() => contract === "context-retrieval.v2" ? transport.takeRetrievalV3Exchange()
        : transport.takeRetrievalExchange()).toThrow(/V3/u);
      expect(() => transport.takeRetrievalExchange()).toThrow(/not captured/u);
    }
  });
});
