import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { suitePlugin } from "./src/channel.js";

export default defineSetupPluginEntry(suitePlugin);
