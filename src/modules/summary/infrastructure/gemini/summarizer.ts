import { ExternalServiceError, type Summarizer } from "../../application/ports/services.js";
import type { SummarizeInput } from "../../domain/summary.js";
import { type GeminiClient, GeminiError, SUMMARY_ERROR_PREFIX } from "./client.js";

/** Gemini固有のエラーや旧来のエラー文字列を、ユースケースの契約へ変換する。 */
export class GeminiSummarizer implements Summarizer {
  constructor(private readonly client: GeminiClient) {}

  async summarize(input: SummarizeInput): Promise<string> {
    try {
      const summary = await this.client.summarize(input);
      if (summary.startsWith(SUMMARY_ERROR_PREFIX)) {
        throw new ExternalServiceError(summary, false);
      }
      return summary;
    } catch (error) {
      if (error instanceof GeminiError) {
        throw new ExternalServiceError(error.message, error.kind === "transient");
      }
      throw error;
    }
  }
}
