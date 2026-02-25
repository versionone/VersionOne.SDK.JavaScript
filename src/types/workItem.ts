export interface WorkItem {
  id: string;
  name: string;
  status: "active" | "closed";
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}