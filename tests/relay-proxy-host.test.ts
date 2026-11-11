import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as https from "node:https";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TurnRelay } from "../src/turn-relay.ts";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return address.port;
}

test("relay uses CONNECT and preserves the upstream Host, never the local relay Host", async () => {
  const certificate = fileURLToPath(new URL("./proxy-fixture-cert.pem", import.meta.url));
  if (process.env.NODE_EXTRA_CA_CERTS !== certificate) {
    // Trust the fixture only in a fresh process; never disable TLS verification.
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    return;
  }
  let host: string | undefined;
  let authority: string | undefined;
  const sockets = new Set<{ destroy(): void }>();
  const upstream = https.createServer({
    key: readFileSync(new URL("./proxy-fixture-key.pem", import.meta.url)),
    cert: readFileSync(new URL("./proxy-fixture-cert.pem", import.meta.url)),
  }, async (request, response) => {
    host = request.headers.host;
    for await (const _chunk of request);
    response.end('data: {"type":"message_start","message":{"id":"test","content":[],"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
  });
  const port = await listen(upstream);
  const proxy = http.createServer();
  proxy.on("connect", (request, client, head) => {
    authority = request.url;
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
  // Port 1 is not the fixture: only the supplied proxy can reach it.
  const relay = new TurnRelay("https://localhost:1", 3000, undefined, undefined, [], {
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: "",
  });
  try {
    const url = await relay.start();
    const response = await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    await response.text();
    await relay.settled();
    assert.equal(response.status, 200, relay.failure);
    assert.equal(authority, "localhost:1");
    assert.equal(host, "localhost:1");
    assert.equal(relay.capture.complete, true);
  } finally {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    await Promise.all([upstream, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});
