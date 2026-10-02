import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BODY_MAX_JSON,
  BODY_MAX_WEBHOOK,
  addressKey,
  capEngineVersion,
  ENGINE_VERSION_MAX,
  IP_LIMITED,
  ipLimited,
  ipLimitState,
  readCapped,
  readJsonCapped,
  resetIpLimitLog,
  tooLarge,
  withinIpLimit,
} from "../src/index.ts";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("https://license.claudinite.com/v1/session-key", { method: "POST", body, headers });

/** A stand-in for the rate-limit binding: `limit` calls allowed per key, every call recorded. */
function limiter(limit: number) {
  const seen: Record<string, number> = {};
  return {
    seen,
    binding: {
      limit: async ({ key }: { key: string }) => {
        seen[key] = (seen[key] ?? 0) + 1;
        return { success: seen[key]! <= limit };
      },
    },
  };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  resetIpLimitLog();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readCapped", () => {
  it("reads a body up to the cap and refuses one byte past it, also when Content-Length is absent", async () => {
    expect((await readCapped(post("a".repeat(16)), 16))?.length).toBe(16);
    expect(await readCapped(post("a".repeat(17)), 16)).toBeNull();
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("a".repeat(17))), c.close()) });
    expect(await readCapped(new Request("https://x.test/", { method: "POST", body: stream, duplex: "half" } as RequestInit), 16)).toBeNull();
  });

  it("refuses a Content-Length claiming more than the cap before reading a byte", async () => {
    const req = post("{}", { "Content-Length": String(BODY_MAX_JSON + 1) });
    const text = vi.spyOn(req, "text");
    expect(await readCapped(req, BODY_MAX_JSON)).toBeNull();
    expect(text).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
  });

  it("reads an empty body as empty", async () => {
    expect(await readCapped(new Request("https://x.test/", { method: "POST" }), 16)).toEqual(new Uint8Array());
  });
});

describe("readJsonCapped", () => {
  it("parses a body of exactly 16 KiB and refuses 16 KiB + 1 as body-too-large", async () => {
    const at = (n: number) => JSON.stringify({ pad: "a".repeat(n - 10) });
    expect(at(BODY_MAX_JSON).length).toBe(BODY_MAX_JSON);
    expect(await readJsonCapped(post(at(BODY_MAX_JSON)), BODY_MAX_JSON)).toMatchObject({ ok: true });
    expect(await readJsonCapped(post(at(BODY_MAX_JSON + 1)), BODY_MAX_JSON)).toEqual({ ok: false, reason: "body-too-large" });
  });

  it("names a body that is not JSON malformed-body", async () => {
    expect(await readJsonCapped(post("not json"), BODY_MAX_JSON)).toEqual({ ok: false, reason: "malformed-body" });
    expect(await readJsonCapped(post(JSON.stringify({ a: 1 })), BODY_MAX_JSON)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("keeps the two caps as the design names them", () => {
    expect([BODY_MAX_JSON, BODY_MAX_WEBHOOK]).toEqual([16 * 1024, 1024 * 1024]);
  });
});

describe("capEngineVersion", () => {
  it("cuts the caller's engine version to 64 characters and leaves a shorter one alone", () => {
    expect(ENGINE_VERSION_MAX).toBe(64);
    expect(capEngineVersion("v".repeat(65))).toBe("v".repeat(64));
    expect(capEngineVersion("1.2.3")).toBe("1.2.3");
  });
});

describe("withinIpLimit", () => {
  const from = (ip: string | null) => new Request("https://license.claudinite.com/v1/key/health", { headers: ip ? { "CF-Connecting-IP": ip } : {} });

  it("keys the binding on the caller's address: the 301st request from one address is refused while another still passes", async () => {
    const { binding, seen } = limiter(300);
    for (let i = 0; i < 300; i++) expect(await withinIpLimit({ IP_LIMIT: binding }, from("192.0.2.1"))).toBe(true);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from("192.0.2.1"))).toBe(false);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from("192.0.2.2"))).toBe(true);
    expect(Object.keys(seen).sort()).toEqual(["ip:192.0.2.1", "ip:192.0.2.2"]);
  });

  it("keys a request without the header on one shared bucket rather than letting it past", async () => {
    const { binding, seen } = limiter(1);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from(null))).toBe(true);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from(null))).toBe(false);
    expect(Object.keys(seen)).toEqual(["ip:unknown"]);
  });

  it("keys an IPv6 caller on its /64, so one host's whole prefix shares a bucket and the next prefix does not", async () => {
    const { binding, seen } = limiter(1);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from("2001:db8:aa:bb::1"))).toBe(true);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from("2001:0db8:00aa:00bb:ffff:eeee:dddd:cccc"))).toBe(false);
    expect(await withinIpLimit({ IP_LIMIT: binding }, from("2001:db8:aa:bc::1"))).toBe(true);
    expect(Object.keys(seen).sort()).toEqual(["ip:2001:db8:aa:bb::/64", "ip:2001:db8:aa:bc::/64"]);
  });

  it("names the /64 the same however the address is written, and leaves IPv4 and IPv4-mapped addresses whole", () => {
    expect(addressKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("2001:db8:0:0:1::")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("192.0.2.1")).toBe("192.0.2.1");
    expect(addressKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(addressKey("unknown")).toBe("unknown");
    expect(addressKey("not:an:address::zz")).toBe("not:an:address::zz");
  });

  it("logs no line per refused request, one ip-limited line a minute with the count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-01T00:00:00Z"));
    const { binding } = limiter(0);
    for (let i = 0; i < 50; i++) await withinIpLimit({ IP_LIMIT: binding }, from("192.0.2.1"));
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ marker: "ip-limited", count: 1 }]);
    vi.setSystemTime(Date.parse("2026-10-01T00:01:01Z"));
    await withinIpLimit({ IP_LIMIT: binding }, from("192.0.2.1"));
    expect(logs.map((l) => JSON.parse(l))).toEqual([{ marker: "ip-limited", count: 1 }, { marker: "ip-limited", count: 50 }]);
  });

  it("lets the request through when the limiter throws or is unbound, logging ip-limit-unavailable once a minute", async () => {
    const broken = { limit: async () => Promise.reject(new Error("acme limiter outage")) };
    for (let i = 0; i < 5; i++) expect(await withinIpLimit({ IP_LIMIT: broken }, from("192.0.2.1"))).toBe(true);
    expect(await withinIpLimit({}, from("192.0.2.1"))).toBe(true);
    expect(logs.map((l) => JSON.parse(l).marker)).toEqual(["ip-limit-unavailable"]);
  });
});

describe("ipLimitState", () => {
  const from = new Request("https://license.claudinite.com/v1/key/health", { headers: { "CF-Connecting-IP": "192.0.2.1" } });

  it("says whether the limiter counted the request, refused it, threw or is unbound, so a health answer can report the cap's wiring", async () => {
    const { binding } = limiter(1);
    expect(await ipLimitState({ IP_LIMIT: binding }, from)).toBe("counted");
    expect(await ipLimitState({ IP_LIMIT: binding }, from)).toBe("refused");
    expect(await ipLimitState({ IP_LIMIT: { limit: async () => Promise.reject(new Error("acme limiter outage")) } }, from)).toBe("unavailable");
    expect(await ipLimitState({}, from)).toBe("unbound");
  });
});

describe("the refusals", () => {
  it("answer 429 rate-limited with Retry-After: 60, and 413 body-too-large, as JSON", async () => {
    expect([ipLimited().status, await ipLimited().json()]).toEqual([429, { refused: IP_LIMITED }]);
    expect(ipLimited().headers.get("Retry-After")).toBe("60");
    expect([tooLarge().status, await tooLarge().json()]).toEqual([413, { refused: "body-too-large" }]);
  });
});
