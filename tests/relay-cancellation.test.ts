import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TurnRelay } from "../src/turn-relay.ts";

test("aborting while CONNECT is pending does not wait for the proxy timeout", { timeout: 5000 }, async () => {
  let notifyConnect: () => void;
  const connected = new Promise<void>((resolve) => { notifyConnect = resolve; });
  const sockets = new Set<{ destroy(): void }>();
  const proxy = http.createServer();
  proxy.on("connect", (_request, socket) => {
    sockets.add(socket);
    notifyConnect();
  });
  const port = await listen(proxy);
  const relay = new TurnRelay("https://localhost:1", 3000, undefined, undefined, [], {
    HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "",
  });
  try {
    const url = await relay.start();
    const pending = fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })
      .then((response) => response.text()).catch(() => "disconnected");
    await connected;
    const started = Date.now();
    relay.abort();
    await relay.settled();
    assert.ok(Date.now() - started < 1000, "cancellation waited for CONNECT timeout");
    assert.equal(relay.status, undefined);
    assert.equal(relay.upstreamFailed, false);
    await pending;
  } finally {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return address.port;
}

const start = 'data: {"type":"message_start","message":{"id":"test","content":[],"stop_reason":"end_turn"}}\n\n';
const stop = 'data: {"type":"message_stop"}\n\n';

test("proxy relay cancellation closes the active turn and permits another turn", { timeout: 15_000 }, async (t) => {
  const certificate = fileURLToPath(new URL("./proxy-fixture-cert.pem", import.meta.url));
  if (process.env.NODE_EXTRA_CA_CERTS !== certificate) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_EXTRA_CA_CERTS: certificate },
      encoding: "utf8", timeout: 12_000,
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    return;
  }
  for (const phase of ["waiting-headers", "streaming"] as const) {
    await t.test(phase, async () => {
      let notifyArrival: () => void;
      const arrived = new Promise<void>((resolve) => { notifyArrival = resolve; });
      let requests = 0;
      const sockets = new Set<{ destroy(): void }>();
      const upstream = https.createServer({
        key: readFileSync(new URL("./proxy-fixture-key.pem", import.meta.url)),
        cert: readFileSync(new URL("./proxy-fixture-cert.pem", import.meta.url)),
      }, async (request, response) => {
        for await (const _chunk of request);
        requests++;
        if (requests > 1) {
          response.end(start + stop);
          return;
        }
        if (phase === "streaming") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(start);
        }
        notifyArrival();
      });
      const port = await listen(upstream);
      const proxy = http.createServer();
      proxy.on("connect", (_request, client, head) => {
        const target = net.connect(port, "127.0.0.1");
        sockets.add(target);
        sockets.add(client);
        target.on("error", () => client.destroy());
        client.on("error", () => target.destroy());
        target.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          target.write(head);
          client.pipe(target).pipe(client);
        });
      });
      const proxyPort = await listen(proxy);
      const relay = new TurnRelay("https://localhost:1", 3000, undefined, undefined, [], {
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "",
      });
      try {
        const url = await relay.start();
        const pending = fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
        const outcome = pending.then(async (response) => {
          await response.text();
          return response.status;
        }).catch(() => "disconnected");
        await arrived;
        if (phase === "streaming") await pending;
        relay.abort();
        relay.abort();
        await relay.settled();
        await outcome;
        assert.equal(relay.capture.complete, false);
        assert.equal(relay.upstreamFailed, false);
        relay.beginTurn();
        const next = await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
        assert.equal(next.status, 200);
        await next.text();
        await relay.settled();
        assert.equal(relay.capture.complete, true);
      } finally {
        await relay.close();
        for (const socket of sockets) socket.destroy();
        upstream.closeAllConnections();
        await Promise.all([upstream, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      }
    });
  }
});
