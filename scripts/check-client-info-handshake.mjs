// Federation handshake contract test (stage 3 of task 019df0ee).
//
// Verifies that the SuiteClient's runtime channel join passes
// `client_info: { product: "openclaw", version: <truthy> }` so the Suite
// dispatch renderer can distinguish OpenClaw runtimes from Claude-channel
// runtimes. We don't open a real WebSocket — `import "phoenix"` is
// redirected via a tiny ESM loader (_phoenix-stub-loader.mjs) to a shim
// that captures the (topic, params) pair on every channel() call.
//
// Loads the COMPILED file from dist/. Run `npm run build` first.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { register } from "node:module";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const compiled = path.join(repoRoot, "dist", "src", "suite-client.js");

if (!existsSync(compiled)) {
  console.error(`Missing ${compiled}. Run \`npm run build\` first.`);
  process.exit(1);
}

// Write the shim that mimics the bits of `phoenix` that suite-client uses.
const shimPath = path.join(repoRoot, "scripts", "_fake-phoenix.mjs");
writeFileSync(
  shimPath,
  `// Auto-generated shim used by check-client-info-handshake.mjs
class FakePush { receive() { return this; } }
class FakeChannel {
  constructor(topic, params) { FakeChannel.captured.push({ topic, params }); }
  on() {} push() { return new FakePush(); } join() { return new FakePush(); } leave() {}
}
FakeChannel.captured = [];
class FakeSocket {
  constructor() {}
  channel(topic, params) { return new FakeChannel(topic, params); }
  onOpen() {} onClose() {} onError() {} connect() {} disconnect() {}
}
export { FakeSocket as Socket, FakeChannel };
`,
);

// Register the loader BEFORE importing the compiled suite-client.
register("./_phoenix-stub-loader.mjs", import.meta.url);

const { SuiteClient } = await import(pathToFileURL(compiled).href);
const shim = await import(pathToFileURL(shimPath).href);

const client = new SuiteClient(
  {
    url: "ws://localhost/socket",
    runtimeId: "test-runtime",
    token: "test-token",
    autoJoinSpaces: [],
    reconnectIntervalMs: 100,
    maxReconnectIntervalMs: 1000,
  },
  {
    onAttention: () => {},
    onToolResult: () => {},
    onDisconnect: () => {},
  },
);

client.connect();

assert.equal(shim.FakeChannel.captured.length, 1, "expected exactly one channel join");
const { topic, params } = shim.FakeChannel.captured[0];
assert.equal(topic, "runtime:test-runtime", `topic should be runtime:<id>, got ${topic}`);
assert.ok(params, "join params object should exist");
assert.ok(params.client_info, "join params should include client_info");
assert.equal(
  params.client_info.product,
  "openclaw",
  `client_info.product should be "openclaw", got ${JSON.stringify(params.client_info.product)}`,
);
assert.ok(
  typeof params.client_info.version === "string" && params.client_info.version.length > 0,
  `client_info.version should be a non-empty string, got ${JSON.stringify(params.client_info.version)}`,
);

client.disconnect();

console.log(
  `Client info handshake OK: topic=${topic}, product=${params.client_info.product}, version=${params.client_info.version}`,
);
