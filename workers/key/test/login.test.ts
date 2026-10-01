import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, env, resetWorld, world } from "./helpers.ts";

beforeEach(() => void resetWorld());
afterEach(() => vi.restoreAllMocks());

describe("GET /v1/login/config", () => {
  it("serves the App's client id and GitHub's device flow URLs, so the binary embeds no App id", async () => {
    const res = await call("/v1/login/config");
    expect(await res.json()).toEqual({ client_id: env().GITHUB_APP_CLIENT_ID, device_code_url: "https://github-web.test/login/device/code", token_url: "https://github-web.test/login/oauth/access_token" });
    expect(env().GITHUB_APP_CLIENT_ID).toBe("Iv23lixTgnYXROPw9nb8");
  });
});

describe("POST /v1/login/refresh", () => {
  const refresh = (e = env({ GITHUB_APP_CLIENT_SECRET: "acme-client-secret" }), body: unknown = { refresh_token: "ghr_old" }) =>
    call("/v1/login/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, e);

  it("forwards a refresh grant with the client secret as a form body and returns GitHub's answer verbatim", async () => {
    const res = await refresh();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15811200 });
    expect(world.calls).toHaveLength(1);
    const sent = world.calls[0]!;
    expect(`${sent.method} ${sent.url}`).toBe("POST https://github-web.test/login/oauth/access_token");
    expect(sent.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(sent.body))).toEqual({ client_id: "Iv23lixTgnYXROPw9nb8", client_secret: "acme-client-secret", grant_type: "refresh_token", refresh_token: "ghr_old" });
  });

  it("returns GitHub's status and body when GitHub refuses", async () => {
    world.oauth = () => Response.json({ error: "bad_refresh_token" }, { status: 400 });
    const res = await refresh();
    expect([res.status, await res.json()]).toEqual([400, { error: "bad_refresh_token" }]);
  });

  it("answers 503 refresh-not-configured while the client secret is unset, calling no one", async () => {
    const res = await refresh(env({ GITHUB_APP_CLIENT_SECRET: undefined }));
    expect([res.status, await res.json()]).toEqual([503, { refused: "refresh-not-configured" }]);
    expect(world.calls).toHaveLength(0);
  });

  it("refuses a body without a refresh token with 400", async () => {
    expect((await refresh(undefined, {})).status).toBe(400);
  });
});
