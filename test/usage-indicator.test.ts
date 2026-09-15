import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUsage, KiroUsageIndicator, registerKiroUsageIndicator } from "../src/usage-indicator.js";

const settingsDirs: string[] = [];
const kiroModel = {
  provider: "kiro",
  id: "gpt-5-6-terra",
  api: "kiro-api",
  baseUrl: "https://runtime.eu-central-1.kiro.dev/",
} as Model<"kiro-api">;

const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "kiro-api",
  provider: "kiro",
  model: "gpt-5-6-terra",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
  ...overrides,
});

function context() {
  const setStatus = vi.fn();
  const fg = vi.fn((_color: string, text: string) => `\u001b[2m${text}\u001b[0m`);
  const find = vi.fn((provider: string, modelId: string) =>
    provider === "kiro" && modelId === kiroModel.id ? kiroModel : undefined,
  );
  const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: true, apiKey: "token" });
  return {
    ctx: {
      modelRegistry: { find, getApiKeyAndHeaders },
      ui: { setStatus, theme: { fg } },
    } as unknown as ExtensionContext,
    setStatus,
    getApiKeyAndHeaders,
  };
}

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of settingsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registerKiroUsageIndicator", () => {
  it("registers only when the boolean setting is true", () => {
    const settingsDir = mkdtempSync(join(tmpdir(), "kiro-usage-indicator-"));
    settingsDirs.push(settingsDir);
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ "pi-provider-kiro": { usageTracking: { planUsageStatusIndicator: true } } }),
    );
    process.env.PI_CODING_AGENT_DIR = settingsDir;
    const on = vi.fn();

    registerKiroUsageIndicator({ on } as unknown as ExtensionAPI);

    expect(on.mock.calls.map(([event]) => event)).toEqual(["message_end"]);
  });

  it("stays disabled for false and nested settings", () => {
    const settingsDir = mkdtempSync(join(tmpdir(), "kiro-usage-indicator-"));
    settingsDirs.push(settingsDir);
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ "pi-provider-kiro": { planUsageStatusIndicator: true } }),
    );
    process.env.PI_CODING_AGENT_DIR = settingsDir;
    const on = vi.fn();

    registerKiroUsageIndicator({ on } as unknown as ExtensionAPI);

    expect(on).not.toHaveBeenCalled();
  });
});

describe("KiroUsageIndicator", () => {
  it("refreshes credit usage after a direct Kiro response", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ used: 50, limit: 200 });
    const indicator = new KiroUsageIndicator({ fetchUsage });
    const { ctx, setStatus, getApiKeyAndHeaders } = context();

    indicator.refresh(message(), ctx);

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith("kiro-usage", "\u001b[2mkiro credits: 25% (50/200)\u001b[0m"),
    );
    expect(getApiKeyAndHeaders).toHaveBeenCalledWith(kiroModel);
    expect(fetchUsage).toHaveBeenCalledWith({ access: "token", region: "eu-central-1", profileArn: undefined });
  });

  it("refreshes after an alias-wrapped Kiro response", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ used: 1, limit: 4 });
    const indicator = new KiroUsageIndicator({ fetchUsage });
    const { ctx, setStatus } = context();

    indicator.refresh(
      message({ api: "alias-api", provider: "alias", model: "gpt-medium", responseModel: "gpt-5-6-terra" }),
      ctx,
    );

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith("kiro-usage", "\u001b[2mkiro credits: 25% (1/4)\u001b[0m"),
    );
  });

  it("clears the status after a response that did not use Kiro", async () => {
    const fetchUsage = vi.fn();
    const indicator = new KiroUsageIndicator({ fetchUsage });
    const { ctx, setStatus } = context();

    indicator.refresh(
      message({ api: "alias-api", provider: "alias", model: "gpt-medium", responseModel: "bedrock-model" }),
      ctx,
    );
    await Promise.resolve();

    expect(fetchUsage).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("kiro-usage", undefined);
  });
  it("does not restore a cleared status when a Kiro refresh finishes late", async () => {
    let resolveUsage: (usage: { used: number; limit: number }) => void = () => {};
    const fetchUsage = vi.fn(
      () =>
        new Promise<{ used: number; limit: number }>((resolve) => {
          resolveUsage = resolve;
        }),
    );
    const indicator = new KiroUsageIndicator({ fetchUsage });
    const { ctx, setStatus } = context();

    indicator.refresh(message(), ctx);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());
    indicator.refresh(
      message({ api: "alias-api", provider: "alias", model: "gpt-medium", responseModel: "bedrock-model" }),
      ctx,
    );
    resolveUsage({ used: 1, limit: 4 });
    await Promise.resolve();
    await Promise.resolve();

    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("kiro-usage", undefined);
  });
});

describe("formatUsage", () => {
  it("keeps quantities below 1,000 unabridged", () => {
    expect(formatUsage({ used: 999.5, limit: 999.99 })).toBe("kiro credits: 100% (999.5/999.99)");
  });

  it("uses lowercase k for quantities above 999", () => {
    expect(formatUsage({ used: 4_323.59, limit: 10_000 })).toBe("kiro credits: 43% (4.32k/10k)");
  });

  it("caps the percentage at 100", () => {
    expect(formatUsage({ used: 15, limit: 10 })).toBe("kiro credits: 100% (15/10)");
  });
});
