import type { PageStatus, PageSummary } from "../../domain/page-summary.js";

export type JobStatus = "queued" | "processing" | "completed" | "failed" | "skipped";

export interface PageRepository {
  upsertPageState(params: {
    pageId: string;
    debounceUntil: string;
    now: string;
  }): Promise<void>;
  getPageState(pageId: string): Promise<PageSummary | null>;
  getDuePages(now: string, limit: number): Promise<PageSummary[]>;
  getSummarizedPages(): Promise<PageSummary[]>;
  bumpRetry(pageId: string, now: string, errorMessage: string): Promise<void>;
  acquireLock(params: {
    pageId: string;
    now: string;
    lockUntil: string;
  }): Promise<boolean>;
  releaseLock(pageId: string, now: string): Promise<void>;
  markPageSummarized(params: {
    pageId: string;
    lastEditedTime: string;
    summary: string;
    title: string;
    url: string;
    category: string;
    author: string;
    expectedDebounceUntil: string;
    now: string;
  }): Promise<void>;
  markPageStatus(params: {
    pageId: string;
    status: PageStatus;
    now: string;
    errorMessage?: string | null;
  }): Promise<void>;
}

export interface JobRepository {
  getLatestJobByPage(pageId: string): Promise<{ id: string } | null>;
  insertJob(params: {
    id: string;
    pageId: string;
    eventType: string;
    payloadLastEditedTime: string | null;
    status: JobStatus;
    queuedAt: string;
    now: string;
  }): Promise<void>;
  updateJobStatus(params: {
    id: string;
    status: JobStatus;
    now: string;
    skippedReason?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    retryCount?: number;
  }): Promise<void>;
}

export interface AppStateStore {
  setAppState(key: string, value: string, now: string): Promise<void>;
}

export interface SummaryRepository extends PageRepository, JobRepository, AppStateStore {}
