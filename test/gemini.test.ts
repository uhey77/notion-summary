import { describe, expect, it } from "vitest";
import {
  GeminiClient,
  GeminiError,
  SUMMARY_ERROR_PREFIX,
  buildPrompt,
} from "../src/services/gemini.js";
import { createFetchMock } from "./helpers/fetchMock.js";

const BASE_OPTS = {
  apiKey: "key",
  model: "gemini-2.5-flash-lite",
  defaultModel: "gemini-2.5-flash-lite",
  length: "medium" as const,
  style: "bullet" as const,
};

function okResponse(text: string) {
  return { body: { candidates: [{ content: { parts: [{ text }] } }] } };
}

describe("buildPrompt", () => {
  it("読者・方針・長さ/形式・本文を含める", () => {
    const p = buildPrompt({ title: "T", markdown: "本文テキスト" }, "short", "paragraph");
    expect(p).toContain("学部生");
    expect(p).toContain("原文の約10%");
    expect(p).not.toContain("最大200字");
    expect(p).toContain("段落形式");
    expect(p).toContain("タイトル: T");
    expect(p).toContain("本文テキスト");
  });

  it("忠実性ルールと区切りを含む (ハルシネーション/インジェクション対策)", () => {
    const p = buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet");
    expect(p).toContain("創作したりしない");
    expect(p).toContain("要約できる本文がありません。");
    expect(p).toContain("-----"); // 入力文書の区切り
  });

  it("構成と認証情報の省略ルールを含む", () => {
    const p = buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet");
    expect(p).toContain("要点"); // 先頭に要点ブロック
    expect(p).toContain("パスワード");
    expect(p).toContain("値は絶対に出力しない");
    expect(p).toContain("サービス名と用途");
    expect(p).toContain("重複を避ける"); // 冗長・重複の排除
  });

  it("旧medium指定でも割合に基づく目安を使う", () => {
    const p = buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet");
    expect(p).toContain("原文の約10%");
    expect(p).not.toContain("最大300字");
  });

  it("category は指定値を、未指定なら『なし』を入れる", () => {
    expect(
      buildPrompt({ title: "T", category: "論文DB", markdown: "M" }, "medium", "bullet"),
    ).toContain("カテゴリ: 論文DB");
    expect(buildPrompt({ title: "T", markdown: "M" }, "medium", "bullet")).toContain(
      "カテゴリ: なし",
    );
  });
});

describe("summarize 成功", () => {
  it("要約本文を返す", async () => {
    const fetchImpl = createFetchMock([
      { match: (u) => u.includes(":generateContent"), responses: [okResponse("これは要約です")] },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out).toBe("これは要約です");
  });
});

describe("summarize モデル fallback", () => {
  it("指定モデル 404 → 既定モデルで成功する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/models/custom-model:"),
        responses: [{ status: 404, body: { error: { message: "model not found" } } }],
      },
      {
        match: (u) => u.includes("/models/gemini-2.5-flash-lite:"),
        responses: [okResponse("fallback 要約")],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, model: "custom-model", fetchImpl });
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out).toBe("fallback 要約");
  });

  it("既定モデルも不可なら『要約生成エラー:』文字列を返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("/models/custom-model:"),
        responses: [{ status: 404, body: { error: { message: "model not found" } } }],
      },
      {
        match: (u) => u.includes("/models/gemini-2.5-flash-lite:"),
        responses: [{ status: 404, body: { error: { message: "also gone" } } }],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, model: "custom-model", fetchImpl });
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out.startsWith(SUMMARY_ERROR_PREFIX)).toBe(true);
  });
});

describe("summarize 一時障害は throw (retry 対象)", () => {
  it("429 は GeminiError(transient) を throw する", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes(":generateContent"),
        responses: [{ status: 429, body: { error: { message: "rate limited" } } }],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.summarize({ title: "T", markdown: "M" })).rejects.toMatchObject({
      name: "GeminiError",
      kind: "transient",
    });
  });

  it("5xx も throw する", async () => {
    const fetchImpl = createFetchMock([
      { match: (u) => u.includes(":generateContent"), responses: [{ status: 503, body: {} }] },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.summarize({ title: "T", markdown: "M" })).rejects.toBeInstanceOf(
      GeminiError,
    );
  });

  it("混雑エラー (high demand) は transient で throw → retry 対象", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes(":generateContent"),
        responses: [
          { status: 503, body: { error: { message: "currently experiencing high demand" } } },
        ],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    await expect(client.summarize({ title: "T", markdown: "M" })).rejects.toMatchObject({
      kind: "transient",
    });
  });
});

describe("課金切れは即 failed (リトライしない)", () => {
  it("クレジット切れ (429+billing文言) は throw せず『要約生成エラー:』を返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes(":generateContent"),
        responses: [
          { status: 429, body: { error: { message: "Your prepayment credits are depleted." } } },
        ],
      },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, fetchImpl });
    // permanent 扱い → throw されず error 文字列を返す → consumer は retry せず failed にする
    const out = await client.summarize({ title: "T", markdown: "M" });
    expect(out.startsWith(SUMMARY_ERROR_PREFIX)).toBe(true);
  });
});

describe("要約本文の保持", () => {
  it("文字数の目安を超えても末尾まで保存する", async () => {
    const summary = `${"あ".repeat(600)}最後の要点。`;
    const fetchImpl = createFetchMock([
      { match: (u) => u.includes(":generateContent"), responses: [okResponse(summary)] },
    ]);
    const client = new GeminiClient({ ...BASE_OPTS, length: "short", fetchImpl });
    expect(await client.summarize({ title: "T", markdown: "M" })).toBe(summary);
  });
});

describe("Vertex AI接続", () => {
  it("指定プロジェクトのglobalエンドポイントとAPIキーヘッダーで要約する", async () => {
    let called = false;
    const fetchImpl = (async (url, init) => {
      called = true;
      expect(JSON.parse(String(init?.body)).contents[0].role).toBe("user");
      expect(String(url)).toBe(
        "https://aiplatform.googleapis.com/v1/projects/notion-summary-510913/locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent",
      );
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("vertex-test-key");
      expect(String(url)).not.toContain("vertex-test-key");
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "要約成功" }] } }] }),
      );
    }) as typeof fetch;
    const client = new GeminiClient({
      ...BASE_OPTS,
      provider: "vertex",
      vertexProjectId: "notion-summary-510913",
      apiKey: "vertex-test-key",
      model: "gemini-3.1-flash-lite",
      fetchImpl,
    });
    expect(await client.summarize({ title: "T", markdown: "M" })).toBe("要約成功");
    expect(called).toBe(true);
  });

  it("Vertexの設定不足を既存Geminiキーへの切り替えで隠さない", async () => {
    const fetchImpl = (async () => {
      throw new Error("呼び出してはいけない");
    }) as typeof fetch;
    const client = new GeminiClient({ ...BASE_OPTS, provider: "vertex", fetchImpl });
    expect(await client.summarize({ title: "T", markdown: "M" })).toContain("未設定");
  });

  it("権限不足をエラーとして返す", async () => {
    const fetchImpl = createFetchMock([
      {
        match: (u) => u.includes("aiplatform.googleapis.com"),
        responses: [{ status: 403, body: { error: { message: "Permission denied" } } }],
      },
    ]);
    const client = new GeminiClient({
      ...BASE_OPTS,
      provider: "vertex",
      vertexProjectId: "notion-summary-510913",
      fetchImpl,
    });
    expect(await client.summarize({ title: "T", markdown: "M" })).toBe(
      "要約生成エラー: Permission denied",
    );
  });
});

it("本文の長さから1割の目安を計算し、条件保持の指示を含める", () => {
  const p = buildPrompt({ title: "T", markdown: "あ".repeat(5000) }, "short", "bullet");
  expect(p).toContain("本文は5000字なので約500字");
  expect(p).toContain("相関を因果として書かない");
  expect(p).toContain("候補、例示、任意の作業を区別する");
  expect(p).not.toContain("2〜3項目");
});
