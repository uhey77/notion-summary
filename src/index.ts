import { handleScheduled } from "./api/cron/handler.js";
import { type WebhookDeps, handleWebhook } from "./api/http/webhook.js";
/**
 * Worker entrypoint (無料構成: Cron + D1)。
 * - fetch: GET / (ヘルスチェック) と POST /notion/webhook を提供する。
 * - scheduled: Cron Trigger で due なページを拾い要約処理する (Queue の代替)。
 */
import { loadConfig } from "./config/config.js";
import type { AppConfig, Env } from "./config/types.js";
import { GeminiClient } from "./modules/summary/infrastructure/gemini/client.js";
import { GeminiSummarizer } from "./modules/summary/infrastructure/gemini/summarizer.js";
import { createLogger } from "./modules/summary/infrastructure/logging/logger.js";
import { NotionClient } from "./modules/summary/infrastructure/notion/client.js";
import { D1SummaryRepository } from "./modules/summary/infrastructure/persistence/d1-summary-repository.js";
import { SlackClient } from "./modules/summary/infrastructure/slack/client.js";
import { SlackDigestPublisher } from "./modules/summary/infrastructure/slack/digest-publisher.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const LOCK_TTL_SECONDS = 120;

function buildNotionClient(config: AppConfig): NotionClient {
  return new NotionClient({
    token: config.notionApiToken ?? "",
    notionVersion: config.notionVersion,
    pageSize: config.notionPageSize,
    maxBlockFetches: config.notionMaxBlockFetches,
    maxBlocks: config.notionMaxBlocks,
    maxMarkdownChars: config.notionMaxMarkdownChars,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const logger = createLogger(config.logLevel);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/notion/webhook") {
      const deps: WebhookDeps = {
        config,
        repository: new D1SummaryRepository(env.DB),
        now: () => new Date(),
        uuid: () => crypto.randomUUID(),
        logger,
      };
      return handleWebhook(request, deps);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    const logger = createLogger(config.logLevel);
    const deps = {
      config,
      repository: new D1SummaryRepository(env.DB),
      source: buildNotionClient(config),
      summarizer: new GeminiSummarizer(
        new GeminiClient({
          apiKey:
            (config.geminiProvider === "vertex" ? config.vertexApiKey : config.geminiApiKey) ?? "",
          provider: config.geminiProvider,
          vertexProjectId: config.vertexProjectId,
          model: config.geminiModel,
          defaultModel: DEFAULT_GEMINI_MODEL,
          length: config.summaryLength,
          style: config.summaryStyle,
        }),
      ),
      publisher: new SlackDigestPublisher(new SlackClient(config.slackBotToken ?? "")),
      now: () => new Date(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      logger,
      maxRetries: config.summaryMaxRetries,
      lockTtlSeconds: LOCK_TTL_SECONDS,
    };
    ctx.waitUntil(handleScheduled(controller.cron, deps));
  },
} satisfies ExportedHandler<Env>;
