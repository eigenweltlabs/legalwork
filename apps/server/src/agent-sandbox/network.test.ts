import { describe, expect, test } from "bun:test";
import { brokerRequest, prepareOutboundRequest, publicAddress } from "./network.js";

const input = { url: "https://example.com/upload?matter=canary", method: "POST", headers: { "Content-Type": "text/plain" }, bodyBase64: Buffer.from("private canary").toString("base64") };

describe("sandbox network boundary", () => {
  test("a denied request performs no DNS resolution or network IO", async () => {
    let resolved = false;
    let sent = false;
    await expect(brokerRequest(prepareOutboundRequest(input), async () => false, new AbortController().signal, {
      resolve: async () => { resolved = true; return [{ address: "93.184.216.34", family: 4 }]; },
      send: async () => { sent = true; return { status: 200, headers: {}, bodyBase64: "" }; },
    })).rejects.toThrow("denied");
    expect({ resolved, sent }).toEqual({ resolved: false, sent: false });
  });

  test("approval binds method, final headers, full body and destination before resolution", async () => {
    const raw = { ...input, headers: { ...input.headers, "Proxy-Authorization": "secret", Connection: "X-Remove", "X-Remove": "hidden" } };
    const request = prepareOutboundRequest(raw);
    raw.url = "https://attacker.example";
    raw.headers["Content-Type"] = "application/json";
    raw.bodyBase64 = "";
    const events: string[] = [];
    await brokerRequest(request, async (approved) => {
      events.push("approve");
      expect(approved).toMatchObject({ url: input.url, bodyBase64: input.bodyBase64, method: "POST", bodyBytes: 14 });
      expect(approved.headers).toEqual({ "content-type": "text/plain", host: "example.com", "content-length": "14", connection: "close" });
      expect(Object.isFrozen(approved)).toBe(true);
      expect(Object.isFrozen(approved.headers)).toBe(true);
      expect(approved.sha256).toMatch(/^[a-f0-9]{64}$/);
      return true;
    }, new AbortController().signal, {
      resolve: async () => { events.push("resolve"); return [{ address: "93.184.216.34", family: 4 }]; },
      send: async (sent, ip) => {
        events.push("send");
        expect(sent).toBe(request);
        expect(ip.address).toBe("93.184.216.34");
        return { status: 302, headers: { location: "http://127.0.0.1/admin" }, bodyBase64: "" };
      },
    });
    // Redirects are returned to the sandbox, never followed in the broker.
    expect(events).toEqual(["approve", "resolve", "send"]);
  });

  test("mixed public/private DNS answers are rejected without a connection", async () => {
    await expect(brokerRequest(prepareOutboundRequest(input), async () => true, new AbortController().signal, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      send: async () => { throw new Error("must not connect"); },
    })).rejects.toThrow("resolves to");
  });

  test("revocation while approval is open stops the request before DNS", async () => {
    const controller = new AbortController();
    await expect(brokerRequest(prepareOutboundRequest(input), async () => { controller.abort(); return true; }, controller.signal, {
      resolve: async () => { throw new Error("must not resolve"); },
      send: async () => { throw new Error("must not connect"); },
    })).rejects.toThrow();
  });

  test.each(["127.0.0.1", "10.4.3.2", "169.254.169.254", "100.100.100.200", "172.20.0.1", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fd00:ec2::254", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::", "0.0.0.0"])("blocks private/metadata/transition address %s", (address) => {
    expect(publicAddress(address)).toBe(false);
  });

  test.each(["http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://[::1]/", "http://user:secret@example.com/", "file:///etc/passwd", "http://localhost/", "http://service.local/"])("rejects unsafe URL %s", (url) => {
    expect(() => prepareOutboundRequest({ ...input, url })).toThrow();
  });

  test("preserves a GET body for the permission check", () => {
    expect(prepareOutboundRequest({ ...input, method: "GET" }).bodyBase64).toBe(input.bodyBase64);
  });

  test("public IPv4 and IPv6 remain usable", () => {
    expect(publicAddress("93.184.216.34")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
