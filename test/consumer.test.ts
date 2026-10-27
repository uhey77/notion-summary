import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types.js";
import {
  type DigestDeps,
  runDailyDigest,
} from "../src/modules/summary/application/usecases/publish-daily-digest.js";
import {
  type SummaryDeps,
  processDuePage,
  processDuePages,
} from "../src/modules/summary/application/usecases/summarize-pages.js";
import { GeminiSummarizer } from "../src/modules/summary/infrastructure/gemini/summarizer.js";
import {
  D1SummaryRepository as Db,
  type PageStateRow,
} from "../src/modules/summary/infrastructure/persistence/d1-summary-repository.js";
import { toPageSummary } from "../src/modules/summary/infrastructure/persistence/d1-summary-repository.js";
import { SlackDigestPublisher } from "../src/modules/summary/infrastructure/slack/digest-publisher.js";

import { GeminiClient } from "../src/modules/summary/infrastructure/gemini/client.js";
import { createLogger } from "../src/modules/summary/infrastructure/logging/logger.js";
import { NotionClient } from "../src/modules/summary/infrastructure/notion/client.js";
import { SlackClient } from "../src/modules/summary/infrastructure/slack/client.js";
import { FakeD1 } from "./helpers/fakeD1.js";
import { type Route, createFetchMock } from "./helpers/fetchMock.js";

type ProcessorDeps = SummaryDeps & DigestDeps & { config: AppConfig };

const PAGE_ID = "page-1";
const LET = "2026-06-06T09:59:00.000Z"; // Notion が返す現在の last_edited_time
const NOW = new Date("2026-06-06T10:11:00.000Z"); // debounce 後

const PAGE_ROUTE: Route = {
  match: (u) => u.includes("/v1/pages/"),
  responses: [
    {
      body: {
        id: PAGE_ID,
        url: "https://notion.so/page-1",
        last_edited_time: LET,
        parent: { type: "database_id", database_id: "db-1" },
        created_by: { object: "user", id: "creator" },
        last_edited_by: { object: "user", id: "user-1" },
        properties: { Name: { type: "title", title: [{ plain_text: "研究ノート" }] } },
      },
    },
  ],
};
const DB_ROUTE: Route = {
  match: (u) => u.includes("/v1/databases/"),
  responses: [{ body: { title: [{ plain_text: "研究DB" }] } }],
};
const USER_ROUTE: Route = {
  match: (u) => u.includes("/v1/users/"),
  responses: [{ body: { name: "田中太郎" } }],
};
const BLOCKS_ROUTE: Route = {
  match: (u) => u.includes("/children"),
  responses: [
    {
      body: {
        results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "本文あり" }] } }],
        has_more: false,
        next_cursor: null,
      },
    },
  ],
};
const GEMINI_OK: Route = {
  match: (u) => u.includes(":generateContent"),
  responses: [{ body: { candidates: [{ content: { parts: [{ text: "要約結果" }] } }] } }],
};
const SLACK_OK: Route = {
  match: (u) => u.includes("chat.postMessage"),
  responses: [{ body: { ok: true, ts: "1.1" } }],
};
// 要約フェーズ用ルート (Slack は含めない = 投稿したら fetchMock が例外を投げるので未投稿の保証になる)。
const SUMMARIZE_ROUTES = [PAGE_ROUTE, DB_ROUTE, BLOCKS_ROUTE, GEMINI_OK, USER_ROUTE];

interface Ctx {
  fake: FakeD1;
  db: Db;
  deps: ProcessorDeps;
  fetchMock: typeof fetch;
}

function buildCtx(options: {
  routes: Route[];
  channels?: string[];
  now?: Date;
  notionDatabaseId?: string;
  digestItemMaxChars?: number;
  digestMaxRetries?: number;
}): Ctx {
  const fetchImpl = createFetchMock(options.routes) as typeof fetch;
  const fake = new FakeD1();
  const db = new Db(fake.asD1());
  const deps: ProcessorDeps = {
    config: {
      notionVersion: "2022-06-28",
      notionDatabaseId: options.notionDatabaseId,
      notionEventTypes: ["page.content_updated"],
      summaryDelaySeconds: 600,
      summaryMinIntervalSeconds: 1800,
      geminiModel: "gemini-3.1-flash-lite",
      summaryLength: "medium",
      summaryStyle: "bullet",
      notionPageSize: 100,
      notionMaxBlockFetches: 30,
      notionMaxBlocks: 800,
      notionMaxMarkdownChars: 30000,
      debugVerbose: false,
      logLevel: "ERROR",
      summaryMaxRetries: 3,
      cronMaxPages: 3,
      digestItemMaxChars: options.digestItemMaxChars ?? 700,
      digestMaxRetries: options.digestMaxRetries ?? 2,
      slackChannelIds: options.channels ?? ["C1"],
    },
    repository: db,
    source: new NotionClient({
      token: "n",
      notionVersion: "2022-06-28",
      pageSize: 100,
      maxBlockFetches: 30,
      maxBlocks: 800,
      maxMarkdownChars: 30000,
      fetchImpl,
    }),
    summarizer: new GeminiSummarizer(
      new GeminiClient({
        apiKey: "k",
        model: "gemini-3.1-flash-lite",
        defaultModel: "gemini-3.1-flash-lite",
        length: "medium",
        style: "bullet",
        fetchImpl,
      }),
    ),
    publisher: new SlackDigestPublisher(new SlackClient("t", fetchImpl)),
    now: () => options.now ?? NOW,
    sleep: async () => {}, // テストでは待たない
    logger: createLogger("ERROR"),
    maxRetries: 3,
    lockTtlSeconds: 120,
  };
  return { fake, db, deps, fetchMock: fetchImpl };
}

/** 要約フェーズ用の pending 行を seed する。 */
function seedState(
  fake: FakeD1,
  overrides: Partial<{
    pageId: string;
    latest: string;
    debounceUntil: string;
    lockUntil: string | null;
    retryCount: number;
  }> = {},
): PageStateRow {
  const row: PageStateRow = {
    page_id: overrides.pageId ?? PAGE_ID,
    // latest = 「前回要約した版」。デフォルトは空 (未要約) なので要約対象になる。
    latest_last_edited_time: overrides.latest ?? "",
    debounce_until: overrides.debounceUntil ?? "2026-06-06T10:10:00.000Z", // 過去 = due
    status: "pending",
    lock_until: overrides.lockUntil ?? null,
    last_summarized_at: null,
    last_summary: null,
    last_title: null,
    last_url: null,
    last_category: null,
    last_author: null,
    slack_ts: null,
    retry_count: overrides.retryCount ?? 0,
    error_message: null,
    created_at: "x",
    updated_at: "x",
  };
  fake.pageStates.set(row.page_id, row);
  return row;
}

/** ダイジェスト用の summarized 行を seed する。 */
function seedSummarized(
  fake: FakeD1,
  opts: {
    pageId: string;
    title: string;
    summary: string;
    author: string;
    url?: string;
    category?: string;
    summarizedAt?: string;
  },
): PageStateRow {
  const row: PageStateRow = {
    page_id: opts.pageId,
    latest_last_edited_time: "2026-06-05T09:00:00.000Z",
    debounce_until: "2026-06-06T00:00:00.000Z",
    status: "summarized",
    lock_until: null,
    last_summarized_at: opts.summarizedAt ?? "2026-06-06T08:00:00.000Z",
    last_summary: opts.summary,
    last_title: opts.title,
    last_url: opts.url ?? `https://notion.so/${opts.pageId}`,
    last_category: opts.category ?? "cat",
    last_author: opts.author,
    slack_ts: null,
    retry_count: 0,
    error_message: null,
    created_at: "x",
    updated_at: "x",
  };
  fake.pageStates.set(row.page_id, row);
  return row;
}

/** fetchMock から chat.postMessage の payload を取り出す。 */
function postBodies(fetchMock: typeof fetch): Array<{ blocks: unknown[]; text: string }> {
  const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return calls
    .filter(([u]) => u.includes("chat.postMessage"))
    .map(([, init]) => JSON.parse(init.body as string));
}

describe("要約フェーズ (processDuePages tick)", () => {
  it("due なページだけ要約して summarized にする", async () => {
    const ctx = buildCtx({ routes: SUMMARIZE_ROUTES });
    seedState(ctx.fake); // due
    seedState(ctx.fake, { pageId: "page-2", debounceUntil: "2026-06-06T23:00:00.000Z" }); // not due
    await processDuePages(ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("summarized");
    expect(ctx.fake.pageStates.get("page-2")?.status).toBe("pending");
  });
});

describe("lock 競合", () => {
  it("ロック取得失敗なら何もしない", async () => {
    const ctx = buildCtx({ routes: SUMMARIZE_ROUTES });
    const state = seedState(ctx.fake, { lockUntil: "2026-06-06T10:12:00.000Z" });
    await processDuePage(toPageSummary(state), ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).not.toBe("summarized");
  });
});

describe("still_editing スキップ", () => {
  it("ロック後の再読み込みで debounce_until が未来なら処理しない", async () => {
    const ctx = buildCtx({ routes: SUMMARIZE_ROUTES });
    const state = seedState(ctx.fake, { debounceUntil: "2026-06-06T10:20:00.000Z" }); // now より後
    await processDuePage(toPageSummary(state), ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).not.toBe("summarized");
  });
});

describe("no_change スキップ (重複防止)", () => {
  it("前回要約した版と現在の last_edited_time が同じなら completed のまま (要約しない)", async () => {
    const ctx = buildCtx({ routes: SUMMARIZE_ROUTES });
    const state = seedState(ctx.fake, { latest: LET }); // = Notion の現在値
    await processDuePage(toPageSummary(state), ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("completed");
    expect(row?.last_summary).toBeNull();
  });
});

describe("対象 DB フィルタ (Cron 側)", () => {
  it("親 DB が NOTION_DATABASE_ID と異なれば other_database でスキップ", async () => {
    const ctx = buildCtx({ routes: SUMMARIZE_ROUTES, notionDatabaseId: "db-OTHER" });
    const state = seedState(ctx.fake);
    await processDuePage(toPageSummary(state), ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("skipped");
  });
});

describe("要約フェーズ 正常系", () => {
  it("要約して summarized にし、メタと作成者を保存する (Slack 投稿しない)", async () => {
    const ctx = buildCtx({ routes: SUMMARIZE_ROUTES });
    const state = seedState(ctx.fake);
    await processDuePage(toPageSummary(state), ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("summarized");
    expect(row?.last_summary).toBe("要約結果");
    expect(row?.last_title).toBe("研究ノート");
    expect(row?.last_url).toBe("https://notion.so/page-1");
    expect(row?.last_category).toBe("研究DB");
    expect(row?.last_author).toBe("田中太郎"); // Users API で解決
    expect(row?.latest_last_edited_time).toBe(LET); // 要約した版を記録
    expect(postBodies(ctx.fetchMock)).toHaveLength(0); // Slack 未投稿
  });

  it("本文が空なら skipped", async () => {
    const emptyBlocks: Route = {
      match: (u) => u.includes("/children"),
      responses: [{ body: { results: [], has_more: false, next_cursor: null } }],
    };
    const ctx = buildCtx({ routes: [PAGE_ROUTE, emptyBlocks] });
    const state = seedState(ctx.fake);
    await processDuePage(toPageSummary(state), ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("skipped");
  });
});

describe("Gemini エラー", () => {
  it("transient(429) は retry(pending, retry_count++)", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        { match: (u) => u.includes(":generateContent"), responses: [{ status: 429, body: {} }] },
      ],
    });
    const state = seedState(ctx.fake);
    await processDuePage(toPageSummary(state), ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("pending");
    expect(row?.retry_count).toBe(1);
    expect(row?.lock_until).toBeNull();
  });

  it("retry 上限到達なら failed", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        { match: (u) => u.includes(":generateContent"), responses: [{ status: 503, body: {} }] },
      ],
    });
    const state = seedState(ctx.fake, { retryCount: 2 });
    await processDuePage(toPageSummary(state), ctx.deps);
    expect(ctx.fake.pageStates.get(PAGE_ID)?.status).toBe("failed");
  });

  it("permanent(モデル不可) は failed (要約保存しない)", async () => {
    const ctx = buildCtx({
      routes: [
        PAGE_ROUTE,
        DB_ROUTE,
        BLOCKS_ROUTE,
        {
          match: (u) => u.includes(":generateContent"),
          responses: [{ status: 404, body: { error: { message: "model not found" } } }],
        },
      ],
    });
    const state = seedState(ctx.fake);
    await processDuePage(toPageSummary(state), ctx.deps);
    const row = ctx.fake.pageStates.get(PAGE_ID);
    expect(row?.status).toBe("failed");
    expect(row?.last_summary).toBeNull();
  });
});

describe("ダイジェストフェーズ (runDailyDigest)", () => {
  it("summarized を1通にまとめて投稿し completed + last_digest_time", async () => {
    const ctx = buildCtx({ routes: [SLACK_OK] });
    seedSummarized(ctx.fake, { pageId: "p1", title: "記事A", summary: "要約A", author: "山田" });
    seedSummarized(ctx.fake, { pageId: "p2", title: "記事B", summary: "要約B", author: "鈴木" });
    await runDailyDigest(ctx.deps);

    const bodies = postBodies(ctx.fetchMock);
    expect(bodies).toHaveLength(1); // 1通にまとまる
    const rendered = JSON.stringify(bodies[0].blocks);
    expect(rendered).not.toContain("今日の更新記事");
    expect(rendered).toContain("記事A");
    expect(rendered).toContain("記事B");
    expect(rendered).toContain("山田");
    expect(rendered).toContain("鈴木");
    expect(ctx.fake.pageStates.get("p1")?.status).toBe("completed");
    expect(ctx.fake.pageStates.get("p2")?.status).toBe("completed");
    expect(ctx.fake.appState.get("last_digest_time")).toBeTruthy();
  });

  it("summarized が無ければ投稿せず last_digest_time だけ更新", async () => {
    const ctx = buildCtx({ routes: [SLACK_OK] });
    await runDailyDigest(ctx.deps);
    expect(postBodies(ctx.fetchMock)).toHaveLength(0);
    expect(ctx.fake.appState.get("last_digest_time")).toBeTruthy();
  });

  it("上限超過で複数メッセージに分割し、全ページを completed にする", async () => {
    // itemMaxChars を大きくして各 block を SECTION_TEXT_MAX(2800) 近くにし、
    // 11件 * ~2800 > MAX_TEXT(28000) で2通に割れるようにする。
    const ctx = buildCtx({ routes: [SLACK_OK], digestItemMaxChars: 3000 });
    for (let i = 0; i < 11; i++) {
      seedSummarized(ctx.fake, {
        pageId: `p${i}`,
        title: `記事${i}`,
        summary: "x".repeat(3000),
        author: "著者",
        summarizedAt: `2026-06-06T08:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    await runDailyDigest(ctx.deps);

    const bodies = postBodies(ctx.fetchMock);
    expect(bodies.length).toBeGreaterThan(1); // 分割された
    for (let i = 0; i < 11; i++) {
      expect(ctx.fake.pageStates.get(`p${i}`)?.status).toBe("completed");
    }
    expect(ctx.fake.appState.get("last_digest_time")).toBeTruthy();
  });

  it("Slack 投稿失敗時はリトライし、成功すれば completed", async () => {
    const ctx = buildCtx({
      routes: [
        {
          match: (u) => u.includes("chat.postMessage"),
          responses: [
            { body: { ok: false, error: "rate_limited" } }, // 1回目失敗
            { body: { ok: true, ts: "1.1" } }, // 2回目成功
          ],
        },
      ],
    });
    seedSummarized(ctx.fake, { pageId: "p1", title: "A", summary: "a", author: "x" });
    await runDailyDigest(ctx.deps);
    expect(postBodies(ctx.fetchMock).length).toBe(2); // リトライで2回投稿
    expect(ctx.fake.pageStates.get("p1")?.status).toBe("completed");
    expect(ctx.fake.appState.get("last_digest_time")).toBeTruthy();
  });

  it("全リトライ失敗なら summarized 据え置き・last_digest_time 未設定", async () => {
    const ctx = buildCtx({
      routes: [
        {
          match: (u) => u.includes("chat.postMessage"),
          responses: [{ body: { ok: false, error: "err" } }],
        },
      ],
    });
    seedSummarized(ctx.fake, { pageId: "p1", title: "A", summary: "a", author: "x" });
    await runDailyDigest(ctx.deps);
    expect(postBodies(ctx.fetchMock).length).toBe(3); // 初回 + 2 リトライ
    expect(ctx.fake.pageStates.get("p1")?.status).toBe("summarized");
    expect(ctx.fake.appState.get("last_digest_time")).toBeUndefined();
  });
});

describe("日次通知の更新期間", () => {
  it("古い更新を除外し、期間開始を含め、締切後の更新は保持する", async () => {
    const ctx = buildCtx({ routes: [SLACK_OK] });
    for (const [pageId, edited] of [
      ["old", "2026-06-04T23:59:59.999Z"],
      ["start", "2026-06-05T00:00:00.000Z"],
      ["next", "2026-06-06T00:00:00.000Z"],
    ]) {
      const row = seedSummarized(ctx.fake, {
        pageId,
        title: pageId,
        summary: "要約",
        author: "更新者",
      });
      row.latest_last_edited_time = edited;
    }
    await runDailyDigest(ctx.deps);
    const rendered = JSON.stringify(postBodies(ctx.fetchMock));
    expect(rendered).toContain("start");
    expect(rendered).not.toContain("old");
    expect(rendered).not.toContain("next");
    expect(ctx.fake.pageStates.get("old")?.status).toBe("skipped");
    expect(ctx.fake.pageStates.get("next")?.status).toBe("summarized");
  });
});
