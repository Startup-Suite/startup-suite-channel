import { createPluginRuntimeStore } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const { setRuntime: setSuiteRuntime, getRuntime: getSuiteRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Startup Suite runtime not initialized");

export { getSuiteRuntime, setSuiteRuntime };
