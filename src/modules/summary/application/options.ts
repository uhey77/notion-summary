export interface SummaryOptions {
  notionDatabaseId?: string;
  cronMaxPages: number;
}
export interface DigestOptions {
  slackChannelIds: string[];
  digestItemMaxChars: number;
  digestMaxRetries: number;
}
export interface UpdateOptions {
  summaryDelaySeconds: number;
  summaryMinIntervalSeconds: number;
}
