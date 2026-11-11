import assert from "node:assert/strict";
import test from "node:test";
import { resolveUpstreamProxy } from "../src/proxy-env.ts";

const HTTPS_TARGET = new URL("https://api.anthropic.com/v1/messages");
const HTTP_TARGET = new URL("http://127.0.0.1:9999/v1/messages");

test("resolves HTTPS_PROXY for https targets across case variants", () => {
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808" }, HTTPS_TARGET)?.href, "http://127.0.0.1:10808/");
  assert.equal(resolveUpstreamProxy({ https_proxy: "http://127.0.0.1:10808" }, HTTPS_TARGET)?.href, "http://127.0.0.1:10808/");
});

test("falls back to ALL_PROXY when HTTPS_PROXY is absent", () => {
  assert.equal(resolveUpstreamProxy({ ALL_PROXY: "http://127.0.0.1:10808" }, HTTPS_TARGET)?.href, "http://127.0.0.1:10808/");
  assert.equal(resolveUpstreamProxy({ all_proxy: "http://127.0.0.1:10808" }, HTTPS_TARGET)?.href, "http://127.0.0.1:10808/");
});

test("prefers HTTPS_PROXY over ALL_PROXY and skips empty values", () => {
  assert.equal(
    resolveUpstreamProxy({ HTTPS_PROXY: "", ALL_PROXY: "http://10.0.0.1:8080" }, HTTPS_TARGET)?.href,
    "http://10.0.0.1:8080/",
  );
  assert.equal(
    resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://10.0.0.1:8080" }, HTTPS_TARGET)?.href,
    "http://127.0.0.1:1/",
  );
});

test("returns undefined without proxy variables", () => {
  assert.equal(resolveUpstreamProxy({}, HTTPS_TARGET), undefined);
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "" }, HTTPS_TARGET), undefined);
});

test("never proxies plain-http (loopback fixture) targets", () => {
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808" }, HTTP_TARGET), undefined);
});

test("honors NO_PROXY with exact, suffix, wildcard and case variants", () => {
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: "api.anthropic.com" }, HTTPS_TARGET), undefined);
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808", no_proxy: "anthropic.com" }, HTTPS_TARGET), undefined);
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: ".anthropic.com" }, HTTPS_TARGET), undefined);
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: "*" }, HTTPS_TARGET), undefined);
  assert.equal(resolveUpstreamProxy({ HTTPS_PROXY: "http://127.0.0.1:10808", NO_PROXY: "claude.ai,EXAMPLE.com" }, HTTPS_TARGET)?.href, "http://127.0.0.1:10808/");
});

test("rejects non-HTTP proxy schemes loudly instead of silently going direct", () => {
  assert.throws(() => resolveUpstreamProxy({ HTTPS_PROXY: "socks5://127.0.0.1:1080" }, HTTPS_TARGET), /HTTP proxy/);
});
