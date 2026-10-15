import type {
  DigestOptions,
  SummaryOptions,
  UpdateOptions,
} from "../modules/summary/application/options.js";
import type { LogLevel } from "../modules/summary/application/ports/logger.js";
import type { SummaryLength, SummaryStyle } from "../modules/summary/domain/summary.js";

/** Cloudflare Workers の環境 bindings / vars / secrets。 */
export interface Env {
  // --- bindings (wrangler.toml) ---
  DB: D1Database;

  // --- vars (非機密、wrangler.toml [vars]) ---
  NOTION_VERSION?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_EVENT_TYPES?: string;
  /** デバウンス: 最後の編集からこの秒数 通知が無ければ要約 (デフォルト 600=10分)。 */
  SUMMARY_DELAY_SECONDS?: string;
  /** クールダウン: 前回要約からこの秒数は次の要約を出さない (デフォルト 1800=30分)。 */
  SUMMARY_MIN_INTERVAL_SECONDS?: string;
  GEMINI_MODEL?: string;
  SUMMARY_LENGTH?: string;
  SUMMARY_STYLE?: string;
  NOTION_PAGE_SIZE?: string;
  NOTION_MAX_BLOCK_FETCHES?: string;
  NOTION_MAX_BLOCKS?: string;
  NOTION_MAX_MARKDOWN_CHARS?: string;
  DEBUG_VERBOSE?: string;
  LOG_LEVEL?: string;
  /** 失敗ジョブの最大リトライ回数 (D1 retry_count ベース。デフォルト 3)。 */
  SUMMARY_MAX_RETRIES?: string;
  /** 1 回の Cron 実行で処理するページ数の上限 (無料 subrequest 枠対策。デフォルト 3)。 */
  CRON_MAX_PAGES?: string;
  /** ダイジェスト 1 記事あたりの要約表示上限文字数 (デフォルト 700)。 */
  DIGEST_ITEM_MAX_CHARS?: string;
  /** ダイジェスト Slack 投稿の実行内リトライ回数 (デフォルト 2)。 */
  DIGEST_MAX_RETRIES?: string;

  // --- secrets (wrangler secret put / .dev.vars) ---
  NOTION_API_TOKEN?: string;
  NOTION_WEBHOOK_TOKEN?: string;
  GEMINI_API_KEY?: string;
  VERTEX_API_KEY?: string;
  GEMINI_PROVIDER?: string;
  VERTEX_PROJECT_ID?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SUMMARY_CHANNEL_ID?: string;
}

/** 起動時の設定。ユースケースには必要な項目だけを渡す。 */
export interface AppConfig extends SummaryOptions, DigestOptions, UpdateOptions {
  notionVersion: string;
  notionEventTypes: string[];
  geminiModel: string;
  summaryLength: SummaryLength;
  summaryStyle: SummaryStyle;
  notionPageSize: number;
  notionMaxBlockFetches: number;
  notionMaxBlocks: number;
  notionMaxMarkdownChars: number;
  debugVerbose: boolean;
  logLevel: LogLevel;
  summaryMaxRetries: number;
  notionApiToken?: string;
  notionWebhookToken?: string;
  geminiApiKey?: string;
  vertexApiKey?: string;
  geminiProvider?: "gemini" | "vertex";
  vertexProjectId?: string;
  slackBotToken?: string;
}
