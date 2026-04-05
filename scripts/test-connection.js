import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Socket } from "phoenix";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const accountId = process.argv[2] || process.env.SUITE_ACCOUNT_ID || "";

let config;
let configSource;

// Multi-agent: read from openclaw.json accounts map
if (accountId) {
  const ocPath = join(process.env.HOME || "~", ".openclaw/openclaw.json");
  try {
    const oc = JSON.parse(readFileSync(ocPath, "utf-8"));
    const account = oc?.channels?.["startup-suite"]?.accounts?.[accountId];
    if (account) {
      config = account;
      configSource = `${ocPath} (account: ${accountId})`;
    }
  } catch {
    // fall through to config.json
  }
}

// Single-agent: try config.json
if (!config) {
  const configPaths = [
    join(process.env.HOME || "~", ".openclaw/extensions/startup-suite-channel/config.json"),
    join(__dirname, "..", "config.json"),
  ];

  for (const p of configPaths) {
    try {
      config = JSON.parse(readFileSync(p, "utf-8"));
      configSource = p;
      break;
    } catch {
      // try next
    }
  }

  if (!config) {
    console.error("✗ No config found. Checked:");
    if (accountId) {
      console.error(`    openclaw.json account: ${accountId}`);
    }
    configPaths.forEach((p) => console.error(`    ${p}`));
    process.exit(1);
  }
}

console.log(`Using config: ${configSource}`);

if (!config.url || !config.runtimeId || !config.token) {
  console.error("✗ Config is missing required fields (url, runtimeId, token)");
  process.exit(1);
}

console.log(`Connecting to ${config.url} as runtime ${config.runtimeId}...`);
console.log("");

// Phoenix expects a global WebSocket
globalThis.WebSocket = WebSocket;

const socket = new Socket(config.url, {
  params: { runtime_id: config.runtimeId, token: config.token },
});

socket.onOpen(() => {
  console.log("✓ WebSocket connected");
});

socket.onError((err) => {
  console.error("✗ WebSocket connection failed");
  if (err?.message) console.error(`  ${err.message}`);
  process.exit(1);
});

socket.connect();

const channel = socket.channel(`runtime:${config.runtimeId}`);

channel
  .join()
  .receive("ok", () => {
    console.log(`✓ Channel joined — runtime:${config.runtimeId}`);
    console.log("");
    console.log("Connection test passed. Your runtime is authenticated and reachable.");
    socket.disconnect();
    process.exit(0);
  })
  .receive("error", (err) => {
    console.error("✗ Channel join failed");
    if (err?.reason) console.error(`  Reason: ${err.reason}`);
    else console.error(`  ${JSON.stringify(err)}`);
    socket.disconnect();
    process.exit(1);
  })
  .receive("timeout", () => {
    console.error("✗ Channel join timed out");
    socket.disconnect();
    process.exit(1);
  });

setTimeout(() => {
  console.error("✗ Connection timed out after 10 seconds");
  socket.disconnect();
  process.exit(1);
}, 10000);
