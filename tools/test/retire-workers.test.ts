import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retireWorkers } from "../retire-workers.mjs";

let server: Server;
let base: string;
let held: Set<string>;
let seen: string[];
let answer: number | null;

beforeEach(async () => {
  held = new Set(["claudinite-router"]);
  seen = [];
  answer = null;
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    const name = decodeURIComponent(/\/workers\/scripts\/([^?]+)/.exec(req.url ?? "")?.[1] ?? "");
    if (answer) {
      res.writeHead(answer, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
    }
    if (!held.delete(name)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }));
    }
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

describe("tools/retire-workers.mjs", () => {
  it("force-deletes each named Worker the account holds and counts a 404 as already gone, so a second run changes nothing", async () => {
    const names = ["claudinite-router", "claudinite-public-key"];
    expect(await retireWorkers({ base, token: "acme-token", accountId: "acme-account", names })).toEqual([
      { name: "claudinite-router", deleted: true },
      { name: "claudinite-public-key", deleted: false },
    ]);
    expect(seen).toEqual(names.map((n) => `DELETE /accounts/acme-account/workers/scripts/${n}?force=true Bearer acme-token`));
    expect((await retireWorkers({ base, token: "acme-token", accountId: "acme-account", names })).map((r) => r.deleted)).toEqual([false, false]);
  });

  it("throws on any other refusal, naming the permission on a 403", async () => {
    answer = 403;
    await expect(retireWorkers({ base, token: "acme-token", accountId: "acme-account", names: ["claudinite-router"] })).rejects.toThrow(/answered 403.*Workers Scripts Edit/);
  });
});
