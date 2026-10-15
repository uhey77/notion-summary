/**
 * 要約処理 & 日次ダイジェスト (Cron 駆動・無料構成)。
 *
 * 2 フェーズ構成:
 *   [要約フェーズ] `processDuePages` — 15 分間隔の Cron。`Db.getDuePages` で due な pending を拾い、
 *     ページごとに要約を生成して D1 に保存する (status=summarized)。Slack 投稿はしない。
 *   [ダイジェストフェーズ] `runDailyDigest` — 9:00 JST の Cron。summarized を集約し、
 *     1 通 (上限超過時は複数) の Slack メッセージにまとめて投稿する。
 *
 * 1 ページの要約処理:
 *   - processing lock を取得 (取れなければ別実行が処理中 → 今回はスキップ、次 tick で再試行)
 *   - ページ再取得 → 現在の last_edited_time が D1 と同じなら no_change スキップ
 *   - 本文取得 → 空なら empty_body スキップ
 *   - Gemini 要約 (permanent エラーは failed)
 *   - 要約結果とメタ (タイトル/URL/カテゴリ/最終更新者) を D1 に保存 (status=summarized)
 *
 * retry 方針:
 *   - 要約フェーズ: notion retryable / gemini transient などの一時失敗は
 *     retry_count < maxRetries なら bumpRetry で pending に戻し (次 tick で再試行)、
 *     上限到達なら failed として記録する (D1 retry_count ベース)。
 *   - ダイジェストフェーズ: Slack 投稿失敗はパート単位で実行内リトライ (digestMaxRetries 回)。
 *     全滅したパートは summarized のまま残し、翌日のダイジェストで再送する。
 */
import type { Db, PageStateRow } from "../db.js";
import { type GeminiClient, GeminiError, SUMMARY_ERROR_PREFIX } from "../services/gemini.js";
import { NotionApiError, type NotionClient } from "../services/notion.js";
import { type SlackClient, type SlackMessage, buildDigestMessages } from "../services/slack.js";
import type { AppConfig } from "../types.js";
import type { Logger } from "../utils/logger.js";

export interface ProcessorDeps {
  config: AppConfig;
  db: Db;
  notion: NotionClient;
  gemini: GeminiClient;
  slack: SlackClient;
  now: () => Date;
  /** リトライ間の待機 (テストでは no-op を注入)。 */
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
  maxRetries: number;
  lockTtlSeconds: number;
}

/** 一時失敗 (retry 対象) を表す内部エラー。 */
class RetryableError extends Error {}

/** 要約フェーズ (Cron 1 回分): due なページを取得し、それぞれ要約して D1 に貯める。 */
export async function processDuePages(deps: ProcessorDeps): Promise<void> {
  const nowIso = deps.now().toISOString();
  const pages = await deps.db.getDuePages(nowIso, deps.config.cronMaxPages);
  deps.logger.info("summarize tick", { due_pages: pages.length });
  for (const page of pages) {
    await processDuePage(page, deps);
  }
}

/**
 * ダイジェストフェーズ (9:00 JST の Cron 1 回分)。
 * summarized なページを集約し、1 通 (上限超過時は複数) の Slack メッセージにまとめて投稿する。
 * 投稿成功したパート単位で completed にし、全パート成功で last_digest_time を更新する。
 * 失敗したパートは summarized のまま残し、翌日のダイジェストで再送する (二重投稿を避ける)。
 */
export async function runDailyDigest(deps: ProcessorDeps): Promise<void> {
  const nowIso = deps.now().toISOString();
  // UTC 0時 = 日本時間9時。Cronの実行遅延に左右されない日次の対象期間。
  const cutoff = new Date(nowIso);
  cutoff.setUTCHours(0, 0, 0, 0);
  const start = cutoff.getTime() - 24 * 60 * 60 * 1000;
  const pages: PageStateRow[] = [];
  for (const page of await deps.db.getSummarizedPages()) {
    const editedAt = Date.parse(page.latest_last_edited_time);
    if (!Number.isFinite(editedAt) || editedAt < start) {
      await deps.db.markPageStatus({ pageId: page.page_id, status: "skipped", now: nowIso });
      deps.logger.info("digest: stale update excluded", { page_id: page.page_id });
    } else if (editedAt < cutoff.getTime()) {
      pages.push(page);
    }
  }
  if (pages.length === 0) {
    await deps.db.setAppState("last_digest_time", nowIso, nowIso);
    deps.logger.info("digest: nothing to post");
    return;
  }

  const channels = deps.config.slackChannelIds;
  if (channels.length === 0) {
    // 設定不備。summarized のまま残し、設定後の次回で投稿する。
    deps.logger.error("no slack channel configured for digest");
    return;
  }

  // 上限超過時は複数メッセージへ自動分割。各 part は載せた pageIds を持つ。
  const parts = buildDigestMessages({
    count: pages.length,
    itemMaxChars: deps.config.digestItemMaxChars,
    items: pages.map((p) => ({
      pageId: p.page_id,
      title: p.last_title ?? "(無題)",
      summaryMarkdown: p.last_summary ?? "",
      url: p.last_url ?? "",
      category: p.last_category ?? "未分類",
      author: p.last_author ?? "不明",
    })),
  });

  let allDelivered = true;
  for (const part of parts) {
    const ok = await postPartWithRetry(deps, channels, part.message, deps.config.digestMaxRetries);
    if (!ok) {
      // 実行内リトライも全滅 → 残りは翌日に回す (既配信パートは completed 済みで再送されない)。
      deps.logger.warn("digest part failed after retries", { page_ids: part.pageIds });
      allDelivered = false;
      break;
    }
    for (const id of part.pageIds) {
      await deps.db.markPageStatus({ pageId: id, status: "completed", now: nowIso });
    }
  }

  if (allDelivered) await deps.db.setAppState("last_digest_time", nowIso, nowIso);
  deps.logger.info("digest posted", { parts: parts.length, all_delivered: allDelivered });
}

/** Slack 投稿を retries 回まで再試行する (全チャンネル ok で成功)。試行間は短い backoff。 */
async function postPartWithRetry(
  deps: ProcessorDeps,
  channels: string[],
  message: SlackMessage,
  retries: number,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const results = await deps.slack.postToChannels(channels, message);
    if (results.length > 0 && results.every((r) => r.ok)) return true;
    if (attempt < retries) {
      deps.logger.warn("digest post retry", { attempt: attempt + 1 });
      await deps.sleep(500 * (attempt + 1)); // 0.5s, 1.0s ...
    }
  }
  return false;
}

/** 1 ページを要約処理する。lock 取得から完了/スキップ/失敗までを担う。 */
export async function processDuePage(state: PageStateRow, deps: ProcessorDeps): Promise<void> {
  const { db, notion, gemini, config, logger } = deps;
  const pageId = state.page_id;
  const nowDate = deps.now();
  const nowIso = nowDate.toISOString();

  // processing lock。取得失敗なら別実行が処理中とみなし今回はスキップ (次 tick で再試行)。
  const lockUntil = new Date(nowDate.getTime() + deps.lockTtlSeconds * 1000).toISOString();
  const locked = await db.acquireLock({ pageId, now: nowIso, lockUntil });
  if (!locked) {
    logger.info("skip: lock held by another run", { page_id: pageId });
    return;
  }

  const jobId = (await db.getLatestJobByPage(pageId))?.id;
  let lockAcquired = true;
  try {
    if (jobId) {
      await db.updateJobStatus({ id: jobId, status: "processing", startedAt: nowIso, now: nowIso });
    }

    // ロック取得後に最新の行を読み直す。getDuePages のスナップショット以降に
    // 新しい Webhook が来て debounce_until が先送りされていたら、まだ編集中とみなしスキップ。
    const fresh = (await db.getPageState(pageId)) ?? state;
    if (Date.parse(fresh.debounce_until) > nowDate.getTime()) {
      await db.releaseLock(pageId, nowIso);
      lockAcquired = false;
      logger.info("skip: still_editing", { page_id: pageId });
      return;
    }

    // ページ取得 (ここで初めて Notion を叩く)。
    const info = await notion.getPageInfo(pageId);

    // 対象 DB フィルタ (Webhook から Cron へ移動)。
    if (config.notionDatabaseId) {
      if (normalizeId(info.parentDatabaseId) !== normalizeId(config.notionDatabaseId)) {
        await db.markPageStatus({ pageId, status: "skipped", now: nowIso });
        lockAcquired = false;
        await skipJob(deps, jobId, "other_database", nowIso);
        logger.info("skip: other_database", { page_id: pageId });
        return;
      }
    }

    // 重複防止: 前回要約した版と同じ last_edited_time なら、内容が変わっていない → スキップ。
    if (fresh.latest_last_edited_time && info.lastEditedTime === fresh.latest_last_edited_time) {
      await db.markPageStatus({ pageId, status: "completed", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "no_change", nowIso);
      logger.info("skip: no_change", { page_id: pageId });
      return;
    }

    // 本文取得 → 空ならスキップ。
    const content = await notion.getPageContent(pageId);
    if (content.markdown.trim().length === 0) {
      await db.markPageStatus({ pageId, status: "skipped", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "empty_body", nowIso);
      logger.info("skip: empty_body", { page_id: pageId });
      return;
    }

    // カテゴリ = 親 DB タイトル (取得失敗は致命的でない)。
    let category = "未分類";
    if (info.parentDatabaseId) {
      const title = await safe(() => notion.getDatabaseTitle(info.parentDatabaseId as string));
      if (title) category = title;
    }

    // Gemini 要約。transient は throw → 下の catch で retry。
    const summary = await gemini.summarize({
      title: info.title,
      category,
      markdown: content.markdown,
    });
    if (summary.startsWith(SUMMARY_ERROR_PREFIX)) {
      // permanent: Slack へ投稿せず failed (spec §20)。
      await failPage(deps, jobId, pageId, summary, nowIso);
      lockAcquired = false;
      return;
    }

    // 最終更新者名を解決 (last_edited_by は partial user=id のみ → Users API で名前を引く)。
    // 失敗しても要約は止めず「不明」にフォールバックする。
    const author = info.lastEditedById
      ? (await safe(() => notion.getUserName(info.lastEditedById as string))) || "不明"
      : "不明";

    // 要約結果とダイジェスト表示用メタを D1 に保存 (status=summarized)。Slack 投稿はダイジェスト側。
    // 処理中に新しい Webhook で debounce_until が変わっていれば pending のまま残す (取りこぼし防止)。
    await db.markPageSummarized({
      pageId,
      lastEditedTime: info.lastEditedTime,
      summary,
      title: info.title,
      url: info.url,
      category,
      author,
      expectedDebounceUntil: fresh.debounce_until,
      now: nowIso,
    });
    lockAcquired = false;
    if (jobId) {
      await db.updateJobStatus({
        id: jobId,
        status: "completed",
        completedAt: nowIso,
        now: nowIso,
      });
    }
    logger.info("summary stored", { job_id: jobId, page_id: pageId });
  } catch (error) {
    await handleFailure(error, deps, jobId, state, nowIso, lockAcquired);
  }
}

async function handleFailure(
  error: unknown,
  deps: ProcessorDeps,
  jobId: string | undefined,
  state: PageStateRow,
  nowIso: string,
  lockAcquired: boolean,
): Promise<void> {
  const pageId = state.page_id;
  if (lockAcquired) await safe(() => deps.db.releaseLock(pageId, nowIso));

  const retryable = isRetryable(error);
  const willRetry = retryable && state.retry_count + 1 < deps.maxRetries;
  if (willRetry) {
    deps.logger.warn("retrying page", {
      page_id: pageId,
      retry_count: state.retry_count,
      error: messageOf(error),
    });
    // pending に戻し retry_count++。次の Cron tick で再度 due として拾われる。
    await safe(() => deps.db.bumpRetry(pageId, nowIso, messageOf(error)));
    if (jobId) {
      await safe(() =>
        deps.db.updateJobStatus({
          id: jobId,
          status: "queued",
          retryCount: state.retry_count + 1,
          now: nowIso,
        }),
      );
    }
    return;
  }

  deps.logger.error("page failed", { page_id: pageId, error: messageOf(error) });
  await failPage(deps, jobId, pageId, messageOf(error), nowIso);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof NotionApiError) return error.retryable;
  if (error instanceof GeminiError) return error.kind === "transient";
  // 未知の例外 (ネットワーク等) は retry に回す。
  return true;
}

async function skipJob(
  deps: ProcessorDeps,
  jobId: string | undefined,
  reason: string,
  nowIso: string,
): Promise<void> {
  if (!jobId) return;
  await safe(() =>
    deps.db.updateJobStatus({ id: jobId, status: "skipped", skippedReason: reason, now: nowIso }),
  );
}

async function failPage(
  deps: ProcessorDeps,
  jobId: string | undefined,
  pageId: string,
  errorMessage: string,
  nowIso: string,
): Promise<void> {
  await safe(() => deps.db.markPageStatus({ pageId, status: "failed", errorMessage, now: nowIso }));
  if (jobId) {
    await safe(() =>
      deps.db.updateJobStatus({
        id: jobId,
        status: "failed",
        errorMessage,
        completedAt: nowIso,
        now: nowIso,
      }),
    );
  }
}

/** 補助処理の失敗で全体を巻き込まないための握り (致命的でない箇所のみ使用)。 */
async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Notion ID をダッシュ除去・小文字化して比較用に正規化する。 */
function normalizeId(id: string | undefined): string {
  return id ? id.replace(/-/g, "").toLowerCase() : "";
}

/** ISO 文字列を JST の "YYYY-MM-DD HH:mm JST" へ整形する。 */
export function formatJst(iso: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const jst = new Date(ms + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())} JST`;
}
