// Tiny ESM loader hook used by check-client-info-handshake.mjs to redirect
// `import "phoenix"` to a local shim that captures channel(topic, params).
import { pathToFileURL } from "node:url";
import path from "node:path";

const shimUrl = pathToFileURL(
  path.resolve(new URL(".", import.meta.url).pathname, "_fake-phoenix.mjs"),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "phoenix") {
    return { url: shimUrl, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
