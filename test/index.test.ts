import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config/types.js";

vi.mock("../src/modules/summary/application/use-cases/summarize-pages.js", () => ({
  processDuePages: vi.fn(),
}));
vi.mock("../src/modules/summary/application/use-cases/publish-daily-digest.js", () => ({
  runDailyDigest: vi.fn(),
}));
import { computeHmacSha256Hex } from "../src/api/http/signature.js";
import worker from "../src/index.js";
import { runDailyDigest } from "../src/modules/summary/application/use-cases/publish-daily-digest.js";
import { processDuePages } from "../src/modules/summary/application/use-cases/summarize-pages.js";
import { FakeD1 } from "./helpers/fakeD1.js";

describe("日次通知", () => {
  beforeEach(() => vi.resetAllMocks());

  async function run(cron: string) {
    const waitUntil = vi.fn();
    await worker.scheduled(
      { cron } as ScheduledController,
      { DB: {} } as Env,
      { waitUntil } as unknown as ExecutionContext,
    );
    await waitUntil.mock.calls[0][0];
  }

  it("毎朝9時のCronだけがSlack通知を実行する", async () => {
    await run("0 0 * * *");
    expect(runDailyDigest).toHaveBeenCalledOnce();
    expect(processDuePages).not.toHaveBeenCalled();
  });

  it.each(["5,20,35,50 * * * *", "* * * * *"])(
    "%s では要約のみ行い通知しない（移行中の旧Cronも含む）",
    async (cron) => {
      await run(cron);
      expect(processDuePages).toHaveBeenCalledOnce();
      expect(runDailyDigest).not.toHaveBeenCalled();
    },
  );
});

describe("WorkerのHTTP入口", () => {
  it("ヘルスチェックはDBへアクセスせずokを返す", async () => {
    const response = await worker.fetch(new Request("https://worker/"), { DB: {} } as Env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("未定義ルートは404を返す", async () => {
    const response = await worker.fetch(new Request("https://worker/missing"), { DB: {} } as Env);
    expect(response.status).toBe(404);
  });

  it("署名付きWebhookからユースケースを経由してD1へ更新と履歴を保存する", async () => {
    const fake = new FakeD1();
    const raw = JSON.stringify({
      type: "page.content_updated",
      entity: { type: "page", id: "p1" },
    });
    const signature = await computeHmacSha256Hex("test-token", raw);
    const response = await worker.fetch(
      new Request("https://worker/notion/webhook", {
        method: "POST",
        body: raw,
        headers: { "X-Notion-Signature": `sha256=${signature}` },
      }),
      { DB: fake.asD1(), NOTION_WEBHOOK_TOKEN: "test-token", LOG_LEVEL: "ERROR" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fake.pageStates.get("p1")?.status).toBe("pending");
    expect([...fake.jobs.values()]).toEqual([
      expect.objectContaining({ page_id: "p1", status: "queued" }),
    ]);
  });
});
