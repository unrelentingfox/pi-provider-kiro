import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKiroRegionFromEndpoint } from "./endpoints.js";
import { fetchKiroCreditUsage, type KiroCreditUsage, type KiroUsageCredentials } from "./usage.js";

const STATUS_KEY = "kiro-usage";

interface KiroModelMetadata {
  kiroRegion?: unknown;
  kiroProfileArn?: unknown;
}

interface UsageIndicatorDependencies {
  fetchUsage: (credentials: KiroUsageCredentials) => Promise<KiroCreditUsage | undefined>;
}

const defaults: UsageIndicatorDependencies = {
  fetchUsage: fetchKiroCreditUsage,
};

export function registerKiroUsageIndicator(pi: ExtensionAPI, dependencies = defaults): void {
  if (!loadPlanUsageStatusIndicatorSetting()) return;

  const indicator = new KiroUsageIndicator(dependencies);
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") indicator.refresh(event.message, ctx);
  });
}

export class KiroUsageIndicator {
  private refreshGeneration = 0;
  private refreshInFlight: Promise<void> | undefined;

  constructor(private readonly dependencies: UsageIndicatorDependencies) {}

  refresh(message: AssistantMessage, ctx: ExtensionContext): void {
    const model = responseModel(message, ctx);
    if (!model) {
      this.refreshGeneration++;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    if (this.refreshInFlight) return;

    const generation = ++this.refreshGeneration;
    this.refreshInFlight = this.fetchAndDisplay(ctx, model, generation).finally(() => {
      this.refreshInFlight = undefined;
    });
  }

  private async fetchAndDisplay(ctx: ExtensionContext, model: Model<"kiro-api">, generation: number): Promise<void> {
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return;

      const metadata = model as typeof model & KiroModelMetadata;
      const usage = await this.dependencies.fetchUsage({
        access: auth.apiKey,
        region: stringMetadata(metadata.kiroRegion) ?? getKiroRegionFromEndpoint(model.baseUrl),
        profileArn: stringMetadata(metadata.kiroProfileArn),
      });
      if (usage && generation === this.refreshGeneration) {
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", formatUsage(usage)));
      }
    } catch {
      // Keep the most recently displayed successful usage status.
    }
  }
}

export function responseModel(message: AssistantMessage, ctx: ExtensionContext): Model<"kiro-api"> | undefined {
  if (message.provider === "kiro")
    return ctx.modelRegistry.find("kiro", message.responseModel ?? message.model) as Model<"kiro-api"> | undefined;
  if (!message.responseModel) return undefined;
  return ctx.modelRegistry.find("kiro", message.responseModel) as Model<"kiro-api"> | undefined;
}

export function formatUsage(usage: KiroCreditUsage): string {
  const percent = usage.limit === 0 ? 0 : Math.min(100, (usage.used / usage.limit) * 100);
  return `kiro credits: ${Math.round(percent)}% (${formatNumber(usage.used)}/${formatNumber(usage.limit)})`;
}

function loadPlanUsageStatusIndicatorSetting(agentDir = getPiAgentDir()): boolean {
  const settings = readSettings(join(agentDir, "settings.json"));
  const tracking = asRecord(asRecord(asRecord(settings)?.["pi-provider-kiro"])?.usageTracking);
  return tracking?.planUsageStatusIndicator === true;
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
  if (value < 1_000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value / 1_000)}k`;
}
