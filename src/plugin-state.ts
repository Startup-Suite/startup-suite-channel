import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SuiteClient, SuiteConfig } from "./suite-client.js";
import { TaskWorkerController } from "./task-worker-controller.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const clients = new Map<string, SuiteClient>();
const spaceToAccountId = new Map<string, string>();
const sessionContexts = new Map<string, unknown>();

let taskWorkers: TaskWorkerController | null = null;

export interface SessionOptions {
  useMcpTools: boolean;
}

const sessionOptions = new Map<string, SessionOptions>();

export function setSessionContext(sessionKey: string, context: unknown): void {
  sessionContexts.set(sessionKey, context);
}

export function getSessionContext(sessionKey: string | null | undefined): unknown {
  if (!sessionKey) return undefined;
  return sessionContexts.get(sessionKey);
}

export function clearSessionContext(sessionKey: string): boolean {
  sessionOptions.delete(sessionKey);
  return sessionContexts.delete(sessionKey);
}

export function setSessionOptions(sessionKey: string, opts: SessionOptions): void {
  sessionOptions.set(sessionKey, opts);
}

export function getSessionOptions(sessionKey: string | null | undefined): SessionOptions | undefined {
  if (!sessionKey) return undefined;
  return sessionOptions.get(sessionKey);
}

export function resolveAccountOptions(cfg: any, accountId: string): SessionOptions {
  const account = channelConfigRoot(cfg)?.accounts?.[accountId];
  return { useMcpTools: Boolean(account?.useMcpTools) };
}

function loadLegacyConfig(): SuiteConfig {
  const raw = readFileSync(join(__dirname, "..", "config.json"), "utf-8");
  return JSON.parse(raw);
}

function channelConfigRoot(cfg: any): any {
  if (cfg?.channels?.["startup-suite"]) return cfg.channels["startup-suite"];
  if (cfg?.accounts) return cfg;
  return null;
}

export function resolveAccountConfig(cfg: any, accountId: string): SuiteConfig | null {
  const root = channelConfigRoot(cfg);
  const account = root?.accounts?.[accountId];
  if (account?.url && account?.runtimeId && account?.token) {
    return {
      url: account.url,
      runtimeId: account.runtimeId,
      token: account.token,
      autoJoinSpaces: account.autoJoinSpaces ?? [],
      reconnectIntervalMs: account.reconnectIntervalMs ?? 5000,
      maxReconnectIntervalMs: account.maxReconnectIntervalMs ?? 60000,
    };
  }

  if (accountId === "default") {
    try {
      return loadLegacyConfig();
    } catch {
      return null;
    }
  }

  return null;
}

export function listConfiguredAccountIds(cfg: any): string[] {
  const accounts = channelConfigRoot(cfg)?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }

  try {
    loadLegacyConfig();
    return ["default"];
  } catch {
    return [];
  }
}

export function setClient(accountId: string, client: SuiteClient) {
  clients.set(accountId, client);
}

export function clearClient(accountId: string) {
  clients.delete(accountId);
  for (const [spaceId, mappedAccountId] of spaceToAccountId.entries()) {
    if (mappedAccountId === accountId) {
      spaceToAccountId.delete(spaceId);
    }
  }

  if (clients.size === 0 && taskWorkers) {
    taskWorkers.shutdown();
    taskWorkers = null;
  }
}

export function rememberSpaceAccount(spaceId: string, accountId: string) {
  spaceToAccountId.set(spaceId, accountId);
}

export function clientForSpace(spaceId?: string | null): SuiteClient | null {
  if (spaceId) {
    const accountId = spaceToAccountId.get(spaceId);
    if (accountId) {
      const client = clients.get(accountId);
      if (client) return client;
    }
  }

  return clients.values().next().value ?? null;
}

export function clientForTool(args: any): SuiteClient | null {
  const spaceId = args?.space_id;
  return clientForSpace(spaceId);
}

export function getTaskWorkers(): TaskWorkerController {
  if (!taskWorkers) {
    taskWorkers = new TaskWorkerController((executionSpaceId?: string) =>
      clientForSpace(executionSpaceId)
    );
  }

  return taskWorkers;
}
