import { describe, expect, it, vi } from "vitest";
import type { SummaryRepository } from "../src/modules/summary/application/ports/repositories.js";
import type {
  DigestPublisher,
  PreparedDigestPart,
} from "../src/modules/summary/application/ports/services.js";
import { ExternalServiceError } from "../src/modules/summary/application/ports/services.js";
import { runDailyDigest } from "../src/modules/summary/application/usecases/publish-daily-digest.js";
import { recordPageUpdate } from "../src/modules/summary/application/usecases/record-page-update.js";
import {
  type SummaryDeps,
  processDuePage,
} from "../src/modules/summary/application/usecases/summarize-pages.js";
import { PageSummary } from "../src/modules/summary/domain/page-summary.js";

const NOW = new Date("2026-10-15T00:00:05.000Z");
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** ユースケースはD1や各APIの実装をインポートせず実行できる。 */
function repository() {
  return {
    getPageState: vi.fn<SummaryRepository["getPageState"]>(),
    getDuePages: vi.fn<SummaryRepository["getDuePages"]>(),
    getSummarizedPages: vi.fn<SummaryRepository["getSummarizedPages"]>(),
    upsertPageState: vi.fn<SummaryRepository["upsertPageState"]>(),
    acquireLock: vi.fn<SummaryRepository["acquireLock"]>(),
    releaseLock: vi.fn<SummaryRepository["releaseLock"]>(),
    bumpRetry: vi.fn<SummaryRepository["bumpRetry"]>(),
    markPageSummarized: vi.fn<SummaryRepository["markPageSummarized"]>(),
    markPageStatus: vi.fn<SummaryRepository["markPageStatus"]>(),
    getLatestJobByPage: vi.fn<SummaryRepository["getLatestJobByPage"]>(),
    insertJob: vi.fn<SummaryRepository["insertJob"]>(),
    updateJobStatus: vi.fn<SummaryRepository["updateJobStatus"]>(),
    setAppState: vi.fn<SummaryRepository["setAppState"]>(),
  };
}

function page(id = "p1") {
  return new PageSummary(
    id,
    "summarized",
    "2026-10-14T12:00:00.000Z",
    "2026-10-14T12:10:00.000Z",
    "2026-10-14T23:55:00.000Z",
    0,
    "要約",
    "記事",
    "https://notion.so/p1",
    "技術",
    "著者",
  );
}

it("ページ更新の記録は業務ルールで次回時刻を決め、履歴を残す", async () => {
  const store = repository();
  store.getPageState.mockResolvedValue(page());
  const id = await recordPageUpdate(
    { pageId: "p1", eventType: "page.content_updated" },
    {
      repository: store,
      config: { summaryDelaySeconds: 600, summaryMinIntervalSeconds: 1800 },
      now: () => NOW,
      uuid: () => "job1",
    },
  );
  expect(id).toBe("job1");
  expect(store.upsertPageState).toHaveBeenCalledWith({
    pageId: "p1",
    debounceUntil: "2026-10-15T00:25:00.000Z",
    now: NOW.toISOString(),
  });
  expect(store.insertJob).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "job1",
      pageId: "p1",
      status: "queued",
    }),
  );
});

describe("要約サービスの共通エラー", () => {
  it.each([true, false])("retryable=%sをサービスの種類によらず扱う", async (retryable) => {
    const store = repository();
    store.acquireLock.mockResolvedValue(true);
    store.getLatestJobByPage.mockResolvedValue(null);
    store.getPageState.mockResolvedValue(page());
    const deps: SummaryDeps = {
      repository: store,
      config: { cronMaxPages: 3 },
      now: () => NOW,
      maxRetries: 3,
      lockTtlSeconds: 120,
      logger,
      source: {
        getPageInfo: async () => ({
          id: "p1",
          title: "記事",
          url: "url",
          lastEditedTime: "new-version",
        }),
        getPageContent: async () => ({ markdown: "本文", blockCount: 1, truncated: false }),
        getDatabaseTitle: async () => undefined,
        getUserName: async () => "",
      },
      summarizer: {
        summarize: async () => {
          throw new ExternalServiceError("service failed", retryable);
        },
      },
    };
    await processDuePage(page(), deps);
    expect(store.releaseLock).toHaveBeenCalledWith("p1", NOW.toISOString());
    if (retryable) {
      expect(store.bumpRetry).toHaveBeenCalledWith("p1", NOW.toISOString(), "service failed");
      expect(store.markPageStatus).not.toHaveBeenCalled();
    } else {
      expect(store.bumpRetry).not.toHaveBeenCalled();
      expect(store.markPageStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    }
    expect(store.markPageSummarized).not.toHaveBeenCalled();
  });
});

it("配信成功したパートだけを完了にし、後続パートの失敗を未配信として残す", async () => {
  const store = repository();
  store.getSummarizedPages.mockResolvedValue([page("p1"), page("p2")]);
  const success = vi
    .fn<PreparedDigestPart["post"]>()
    .mockResolvedValue([{ channel: "C1", ok: true }]);
  const failure = vi
    .fn<PreparedDigestPart["post"]>()
    .mockResolvedValue([{ channel: "C1", ok: false }]);
  const publisher: DigestPublisher = {
    prepare: () => [
      { pageIds: ["p1"], post: success },
      { pageIds: ["p2"], post: failure },
    ],
  };
  const sleep = vi.fn();
  await runDailyDigest({
    repository: store,
    publisher,
    now: () => NOW,
    sleep,
    logger,
    config: { slackChannelIds: ["C1"], digestItemMaxChars: 700, digestMaxRetries: 2 },
  });
  expect(success).toHaveBeenCalledOnce();
  expect(failure).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
  expect(store.markPageStatus).toHaveBeenCalledExactlyOnceWith({
    pageId: "p1",
    status: "completed",
    now: NOW.toISOString(),
  });
  expect(store.setAppState).not.toHaveBeenCalled();
});
