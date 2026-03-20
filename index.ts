import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { suitePlugin } from "./src/channel.js";
import { setSuiteRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "startup-suite",
  name: "Startup Suite",
  description: "Federated agent runtime via Startup Suite",
  plugin: suitePlugin,
  setRuntime: setSuiteRuntime,
});
