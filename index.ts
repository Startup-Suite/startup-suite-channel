import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { suitePlugin } from "./src/channel.js";
import { setSuiteRuntime } from "./src/runtime.js";

const plugin = {
  id: "startup-suite-channel",
  name: "Startup Suite",
  description: "Federated agent runtime via Startup Suite",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSuiteRuntime(api.runtime);
    api.registerChannel({ plugin: suitePlugin });
  },
};

export default plugin;
