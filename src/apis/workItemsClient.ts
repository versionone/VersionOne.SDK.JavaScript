import type { Transport } from "../core/transport";
import type { PaginatedResult, WorkItem } from "../types/workItem";

export class WorkItemsClient {
  constructor(private readonly transport: Transport) {}

  list(cursor?: string): Promise<PaginatedResult<WorkItem>> {
    return this.transport.request<PaginatedResult<WorkItem>>({
      method: "GET",
      path: "/api/workitems",
      query: { cursor }
    });
  }

  getById(id: string): Promise<WorkItem> {
    return this.transport.request<WorkItem>({
      method: "GET",
      path: `/api/workitems/${encodeURIComponent(id)}`
    });
  }
}