import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchKiroCreditUsage, type KiroCreditUsage, type KiroUsageCredentials } from "./usage.js";

const STATUS_KEY = "kiro-usage";
const REFRESH_TTL_MS = 5 * 60 * 1000;

interface UsageIndicatorSettings {
  enabled: boolean;
}

interface KiroModelMetadata {
  kiroRegion?: unknown;
  kiroProfileArn?: unknown;
  region?: unknown;
  profileArn?: unknown;
}

interface UsageIndicatorDependencies {
  fetchUsage: (credentials: KiroUsageCredentials) => Promise<KiroCreditUsage | undefined>;
  now: () => number;
}

const defaults: UsageIndicatorDependencies = {
  fetchUsage: fetchKiroCreditUsage,
  now: Date.now,
};

export function registerKiroUsageIndicator(pi: ExtensionAPI, dependencies = defaults): void {
  if (!loadUsageIndicatorSettings().enabled) return;

  const indicator = new KiroUsageIndicator(dependencies);
  pi.on("session_start", (_event, ctx) => indicator.refresh(ctx));
  pi.on("model_select", (_event, ctx) => indicator.refresh(ctx));
  pi.on("agent_end", (_event, ctx) => indicator.refresh(ctx));
}

export class KiroUsageIndicator {
  private lastRefreshAt = 0;
  private refreshInFlight: Promise<void> | undefined;

  constructor(private readonly dependencies: UsageIndicatorDependencies) {}

  refresh(ctx: ExtensionContext): void {
    if (ctx.model?.provider !== "kiro") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    if (this.isFresh() || this.refreshInFlight) return;

    this.lastRefreshAt = this.dependencies.now();
    const model = ctx.model;
    this.refreshInFlight = this.fetchAndDisplay(ctx, model).finally(() => {
      this.refreshInFlight = undefined;
    });
  }

  private isFresh(): boolean {
    return this.lastRefreshAt > 0 && this.dependencies.now() - this.lastRefreshAt < REFRESH_TTL_MS;
  }

  private async fetchAndDisplay(ctx: ExtensionContext, selectedModel: NonNullable<ExtensionContext["model"]>): Promise<void> {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
      if (!auth.ok || !auth.apiKey) return;

      const model = selectedModel as typeof selectedModel & KiroModelMetadata;
      const usage = await this.dependencies.fetchUsage({
        access: auth.apiKey,
        region: stringMetadata(model.kiroRegion) ?? stringMetadata(model.region),
        profileArn: stringMetadata(model.kiroProfileArn) ?? stringMetadata(model.profileArn),
      });
      if (!usage || ctx.model !== selectedModel) return;

      ctx.ui.setStatus(STATUS_KEY, formatUsage(usage));
    } catch {
      // Keep the most recently displayed successful usage status.
    }
  }
}

export function formatUsage(usage: KiroCreditUsage): string {
  const percent = usage.limit === 0 ? 0 : Math.min(100, (usage.used / usage.limit) * 100);
  return `Kiro: ${formatNumber(usage.used)}/${formatNumber(usage.limit)} credits (${percent.toFixed(1)}%)`;
}

function loadUsageIndicatorSettings(agentDir = getPiAgentDir()): UsageIndicatorSettings {
  const settings = readSettings(join(agentDir, "settings.json"));
  const providerSettings = asRecord(asRecord(settings)?.["pi-provider-kiro"]);
  const section = asRecord(providerSettings?.usageIndicator);
  return { enabled: section?.enabled === true };
}

function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readSettings(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
