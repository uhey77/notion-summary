/** 要約フェーズ。期限が来たページを取得し、ロック・重複判定・再試行を制御する。 */
import { type PageSummary, belongsToDatabase } from "../../domain/page-summary.js";
import type { SummaryOptions } from "../options.js";
import type { Logger } from "../ports/logger.js";
import type { JobRepository, PageRepository } from "../ports/repositories.js";
import { ExternalServiceError, type PageSource, type Summarizer } from "../ports/services.js";
import { messageOf, safe } from "./support.js";

export interface SummaryDeps {
  config: SummaryOptions;
  repository: PageRepository & JobRepository;
  source: PageSource;
  summarizer: Summarizer;
  now: () => Date;
  logger: Logger;
  maxRetries: number;
  lockTtlSeconds: number;
}

/** 要約フェーズ (Cron 1 回分): due なページを取得し、それぞれ要約して D1 に貯める。 */
export async function processDuePages(deps: SummaryDeps): Promise<void> {
  const nowIso = deps.now().toISOString();
  const pages = await deps.repository.getDuePages(nowIso, deps.config.cronMaxPages);
  deps.logger.info("summarize tick", { due_pages: pages.length });
  for (const page of pages) {
    await processDuePage(page, deps);
  }
}

/** 1 ページを要約処理する。lock 取得から完了/スキップ/失敗までを担う。 */
export async function processDuePage(state: PageSummary, deps: SummaryDeps): Promise<void> {
  const { repository, source, summarizer, config, logger } = deps;
  const pageId = state.pageId;
  const nowDate = deps.now();
  const nowIso = nowDate.toISOString();

  // processing lock。取得失敗なら別実行が処理中とみなし今回はスキップ (次 tick で再試行)。
  const lockUntil = new Date(nowDate.getTime() + deps.lockTtlSeconds * 1000).toISOString();
  const locked = await repository.acquireLock({ pageId, now: nowIso, lockUntil });
  if (!locked) {
    logger.info("skip: lock held by another run", { page_id: pageId });
    return;
  }

  const jobId = (await repository.getLatestJobByPage(pageId))?.id;
  let lockAcquired = true;
  try {
    if (jobId) {
      await repository.updateJobStatus({
        id: jobId,
        status: "processing",
        startedAt: nowIso,
        now: nowIso,
      });
    }

    // ロック取得後に最新の行を読み直す。getDuePages のスナップショット以降に
    // 新しい Webhook が来て debounce_until が先送りされていたら、まだ編集中とみなしスキップ。
    const fresh = (await repository.getPageState(pageId)) ?? state;
    if (fresh.isStillEditing(nowDate)) {
      await repository.releaseLock(pageId, nowIso);
      lockAcquired = false;
      logger.info("skip: still_editing", { page_id: pageId });
      return;
    }

    // ページ取得 (ここで初めて Notion を叩く)。
    const info = await source.getPageInfo(pageId);

    // 対象 DB フィルタ (Webhook から Cron へ移動)。
    if (!belongsToDatabase(info.parentDatabaseId, config.notionDatabaseId)) {
      await repository.markPageStatus({ pageId, status: "skipped", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "other_database", nowIso);
      logger.info("skip: other_database", { page_id: pageId });
      return;
    }

    // 重複防止: 前回要約した版と同じ last_edited_time なら、内容が変わっていない → スキップ。
    if (fresh.hasSummarizedVersion(info.lastEditedTime)) {
      await repository.markPageStatus({ pageId, status: "completed", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "no_change", nowIso);
      logger.info("skip: no_change", { page_id: pageId });
      return;
    }

    // 本文取得 → 空ならスキップ。
    const content = await source.getPageContent(pageId);
    if (content.markdown.trim().length === 0) {
      await repository.markPageStatus({ pageId, status: "skipped", now: nowIso });
      lockAcquired = false;
      await skipJob(deps, jobId, "empty_body", nowIso);
      logger.info("skip: empty_body", { page_id: pageId });
      return;
    }

    // カテゴリ = 親 DB タイトル (取得失敗は致命的でない)。
    let category = "未分類";
    if (info.parentDatabaseId) {
      const title = await safe(() => source.getDatabaseTitle(info.parentDatabaseId as string));
      if (title) category = title;
    }

    // 要約サービスの一時失敗は下のcatchで再試行する。
    const summary = await summarizer.summarize({
      title: info.title,
      category,
      markdown: content.markdown,
    });
    // 最終更新者名を解決 (last_edited_by は partial user=id のみ → Users API で名前を引く)。
    // 失敗しても要約は止めず「不明」にフォールバックする。
    const author = info.lastEditedById
      ? (await safe(() => source.getUserName(info.lastEditedById as string))) || "不明"
      : "不明";

    // 要約結果とダイジェスト表示用メタを D1 に保存 (status=summarized)。Slack 投稿はダイジェスト側。
    // 処理中に新しい Webhook で debounce_until が変わっていれば pending のまま残す (取りこぼし防止)。
    await repository.markPageSummarized({
      pageId,
      lastEditedTime: info.lastEditedTime,
      summary,
      title: info.title,
      url: info.url,
      category,
      author,
      expectedDebounceUntil: fresh.debounceUntil,
      now: nowIso,
    });
    lockAcquired = false;
    if (jobId) {
      await repository.updateJobStatus({
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
  deps: SummaryDeps,
  jobId: string | undefined,
  state: PageSummary,
  nowIso: string,
  lockAcquired: boolean,
): Promise<void> {
  const pageId = state.pageId;
  if (lockAcquired) await safe(() => deps.repository.releaseLock(pageId, nowIso));

  const retryable = isRetryable(error);
  const willRetry = state.canRetry(retryable, deps.maxRetries);
  if (willRetry) {
    deps.logger.warn("retrying page", {
      page_id: pageId,
      retry_count: state.retryCount,
      error: messageOf(error),
    });
    // pending に戻し retry_count++。次の Cron tick で再度 due として拾われる。
    await safe(() => deps.repository.bumpRetry(pageId, nowIso, messageOf(error)));
    if (jobId) {
      await safe(() =>
        deps.repository.updateJobStatus({
          id: jobId,
          status: "queued",
          retryCount: state.retryCount + 1,
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
  return error instanceof ExternalServiceError ? error.retryable : true;
}

async function skipJob(
  deps: SummaryDeps,
  jobId: string | undefined,
  reason: string,
  nowIso: string,
): Promise<void> {
  if (!jobId) return;
  await safe(() =>
    deps.repository.updateJobStatus({
      id: jobId,
      status: "skipped",
      skippedReason: reason,
      now: nowIso,
    }),
  );
}

async function failPage(
  deps: SummaryDeps,
  jobId: string | undefined,
  pageId: string,
  errorMessage: string,
  nowIso: string,
): Promise<void> {
  await safe(() =>
    deps.repository.markPageStatus({ pageId, status: "failed", errorMessage, now: nowIso }),
  );
  if (jobId) {
    await safe(() =>
      deps.repository.updateJobStatus({
        id: jobId,
        status: "failed",
        errorMessage,
        completedAt: nowIso,
        now: nowIso,
      }),
    );
  }
}
