import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUsage, KiroUsageIndicator, registerKiroUsageIndicator } from "../src/usage-indicator.js";

const credentials = {
  access: "token",
  region: "us-east-1",
  profileArn: "arn:profile",
};

const settingsDirs: string[] = [];

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  for (const dir of settingsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(provider = "kiro") {
  const setStatus = vi.fn();
  const getApiKeyAndHeaders = vi.fn().mockResolvedValue({ ok: true, apiKey: "token" });
  return {
    ctx: {
      model: { provider, ...credentials },
      modelRegistry: { getApiKeyAndHeaders },
      ui: { setStatus },
    } as unknown as ExtensionContext,
    setStatus,
    getApiKeyAndHeaders,
  };
}

describe("registerKiroUsageIndicator", () => {
  it("registers lifecycle handlers only when enabled", () => {
    const settingsDir = mkdtempSync(join(tmpdir(), "kiro-usage-indicator-"));
    settingsDirs.push(settingsDir);
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ "pi-provider-kiro": { usageIndicator: { enabled: true } } }),
    );
    process.env.PI_CODING_AGENT_DIR = settingsDir;
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;

    registerKiroUsageIndicator(pi);

    expect(on.mock.calls.map(([event]) => event)).toEqual(["session_start", "model_select", "agent_end"]);
  });
});

describe("KiroUsageIndicator", () => {
  it("displays a successful Kiro credit usage refresh", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ used: 4323.59, limit: 10_000 });
    const indicator = new KiroUsageIndicator({ fetchUsage, now: () => 1_000 });
    const { ctx, setStatus } = context();

    indicator.refresh(ctx);
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith("kiro-usage", "Kiro: 4,323.59/10,000 credits (43.2%)"));
    expect(fetchUsage).toHaveBeenCalledWith(credentials);
  });

  it("clears the status when the selected model is not Kiro", () => {
    const indicator = new KiroUsageIndicator({ fetchUsage: vi.fn(), now: () => 1_000 });
    const { ctx, setStatus } = context("anthropic");

    indicator.refresh(ctx);

    expect(setStatus).toHaveBeenCalledWith("kiro-usage", undefined);
  });

  it("shares an in-flight request and respects the refresh time to live", async () => {
    let resolveUsage: (usage: { used: number; limit: number }) => void = () => {};
    const fetchUsage = vi.fn(
      () =>
        new Promise<{ used: number; limit: number }>((resolve) => {
          resolveUsage = resolve;
        }),
    );
    let now = 1_000;
    const indicator = new KiroUsageIndicator({ fetchUsage, now: () => now });
    const { ctx } = context();

    indicator.refresh(ctx);
    indicator.refresh(ctx);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());

    resolveUsage({ used: 1, limit: 10 });
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());
    now += 60_000;
    indicator.refresh(ctx);
    expect(fetchUsage).toHaveBeenCalledOnce();
  });

  it("keeps a prior status and throttles retries when a later refresh fails", async () => {
    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce({ used: 1, limit: 10 })
      .mockRejectedValueOnce(new Error("unavailable"));
    let now = 1_000;
    const indicator = new KiroUsageIndicator({ fetchUsage, now: () => now });
    const { ctx, setStatus } = context();

    indicator.refresh(ctx);
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledOnce());
    now += 5 * 60 * 1000;
    indicator.refresh(ctx);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
    indicator.refresh(ctx);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledOnce();
  });

  it("does not restore a stale Kiro status after switching providers", async () => {
    let resolveUsage: (usage: { used: number; limit: number }) => void = () => {};
    const fetchUsage = vi.fn(
      () =>
        new Promise<{ used: number; limit: number }>((resolve) => {
          resolveUsage = resolve;
        }),
    );
    const indicator = new KiroUsageIndicator({ fetchUsage, now: () => 1_000 });
    const { ctx, setStatus } = context();

    indicator.refresh(ctx);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());
    (ctx as { model: { provider: string } }).model = { provider: "anthropic" };
    indicator.refresh(ctx);
    resolveUsage({ used: 1, limit: 10 });
    await Promise.resolve();
    await Promise.resolve();

    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("kiro-usage", undefined);
  });
});

describe("formatUsage", () => {
  it("caps percent at 100", () => {
    expect(formatUsage({ used: 15, limit: 10 })).toBe("Kiro: 15/10 credits (100.0%)");
  });
});
