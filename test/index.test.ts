import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types.js";

vi.mock("../src/handlers/consumer.js", () => ({
  processDuePages: vi.fn(),
  runDailyDigest: vi.fn(),
}));
import { processDuePages, runDailyDigest } from "../src/handlers/consumer.js";
import worker from "../src/index.js";

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
