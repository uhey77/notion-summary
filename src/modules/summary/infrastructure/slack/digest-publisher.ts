import type { DigestPublisher, PreparedDigestPart } from "../../application/ports/services.js";
import { type SlackClient, buildDigestMessages } from "./client.js";

export class SlackDigestPublisher implements DigestPublisher {
  constructor(private readonly client: SlackClient) {}

  prepare(input: Parameters<DigestPublisher["prepare"]>[0]): PreparedDigestPart[] {
    return buildDigestMessages(input).map((part) => ({
      pageIds: part.pageIds,
      post: (channels) => this.client.postToChannels(channels, part.message),
    }));
  }
}
