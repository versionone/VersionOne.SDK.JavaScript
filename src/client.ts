import { WorkItemsClient } from "./apis/workItemsClient";
import type { ClientConfig } from "./core/clientConfig";
import { createFetchTransport } from "./core/fetchTransport";

export class VersionOneClient {
  readonly workItems: WorkItemsClient;

  constructor(config: ClientConfig) {
    const transport = createFetchTransport({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      accessToken: config.accessToken,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      defaultHeaders: config.defaultHeaders
    });

    this.workItems = new WorkItemsClient(transport);
  }
}