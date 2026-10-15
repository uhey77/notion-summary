import { describe, expect, it } from "vitest";
import { DigestWindow } from "../src/modules/summary/domain/digest.js";
import {
  PageSummary,
  belongsToDatabase,
  nextSummaryTime,
} from "../src/modules/summary/domain/page-summary.js";

const NOW = new Date("2026-10-15T00:00:05.000Z");

function page(retryCount = 0, lastEditedTime = "version-1") {
  return new PageSummary(
    "p1",
    "pending",
    lastEditedTime,
    "2026-10-15T00:00:05.000Z",
    null,
    retryCount,
    null,
    null,
    null,
    null,
    null,
  );
}

describe("ページ要約の業務ルール", () => {
  it.each([
    [undefined, "2026-10-15T00:10:05.000Z"],
    ["invalid", "2026-10-15T00:10:05.000Z"],
    ["2026-10-14T22:00:00.000Z", "2026-10-15T00:10:05.000Z"],
    ["2026-10-14T23:55:00.000Z", "2026-10-15T00:25:00.000Z"],
  ])("前回要約%sに対してデバウンスとクールダウンを守る", (previous, expected) => {
    expect(nextSummaryTime(NOW, 600, 1800, previous)).toBe(expected);
  });

  it("待機期限ちょうどから処理できる", () => {
    expect(page().isStillEditing(new Date(NOW.getTime() - 1))).toBe(true);
    expect(page().isStillEditing(NOW)).toBe(false);
  });

  it("初回の空の版を要約済みと判定しない", () => {
    expect(page(0, "").hasSummarizedVersion("")).toBe(false);
    expect(page().hasSummarizedVersion("version-1")).toBe(true);
    expect(page().hasSummarizedVersion("version-2")).toBe(false);
  });

  it.each([
    [0, true, true],
    [1, true, true],
    [2, true, false],
    [0, false, false],
  ])("試行上限3回: retryCount=%i, retryable=%s", (count, retryable, expected) => {
    expect(page(count).canRetry(retryable, 3)).toBe(expected);
  });

  it("DBのID表記を正規化して比較する", () => {
    expect(belongsToDatabase("AB-CD", "abcd")).toBe(true);
    expect(belongsToDatabase(undefined, "abcd")).toBe(false);
    expect(belongsToDatabase("other", undefined)).toBe(true);
  });
});

describe("日次ダイジェストの対象期間", () => {
  const window = new DigestWindow(NOW);
  it.each([
    ["2026-10-13T23:59:59.999Z", "stale"],
    ["2026-10-14T00:00:00.000Z", "included"],
    ["2026-10-14T23:59:59.999Z", "included"],
    ["2026-10-15T00:00:00.000Z", "future"],
    ["2026-10-16T00:00:00.000Z", "future"],
    ["invalid", "stale"],
  ])("更新時刻%sは%s", (editedAt, classification) => {
    expect(window.classify(editedAt)).toBe(classification);
  });
});
