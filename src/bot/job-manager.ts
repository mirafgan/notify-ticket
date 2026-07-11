import { EventEmitter } from 'node:events';
import type { BrowserContext, Page } from 'playwright';
import {
  buildRuntimeConfig,
  createScrapeKey,
  formatPrice,
  launchBrowser,
  normalizeRequest,
  runChecks,
  type AdyRequest,
  type AdyRequestInput,
  type CheckBatch,
  type RuntimeConfig,
  type TicketsFoundResult,
} from '../modules/ady/scraper';

export interface AdySubscriber {
  chatId: string;
  userId: string | number;
  username: string;
  maxPrice: number;
  createdAt: Date;
}

export interface AdyJob {
  key: string;
  request: AdyRequest;
  subscribers: Map<string, AdySubscriber>;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
}

interface AdyJobManagerOptions {
  runtimeConfig?: Partial<RuntimeConfig>;
  maxConcurrentChecks?: number | string;
  stopOnAvailable?: boolean;
  log?: (message: string) => void;
}

interface SubscriberInput {
  chatId: number | string;
  userId?: number | string;
  username?: string;
}

interface QueueItem {
  task: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export interface SubscriptionResult {
  created: boolean;
  job: AdyJob;
  subscriberCount: number;
}

export interface ChatJob {
  job: AdyJob;
  subscriber: AdySubscriber;
}

export interface AvailableEvent {
  job: AdyJob;
  subscriber: AdySubscriber;
  matches: TicketsFoundResult[];
  message: string;
}

export interface JobErrorEvent {
  job: AdyJob;
  error: unknown;
}

export interface CheckedEvent {
  job: AdyJob;
  batch: CheckBatch;
  nextCheckInMs: number;
}

export class AdyJobManager extends EventEmitter {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly maxConcurrentChecks: number;
  private readonly stopOnAvailable: boolean;
  private readonly jobs = new Map<string, AdyJob>();
  private readonly queue: QueueItem[] = [];
  private readonly log: (message: string) => void;
  private activeChecks = 0;
  private contextPromise: Promise<BrowserContext> | null = null;
  private context: BrowserContext | null = null;

  constructor(options: AdyJobManagerOptions = {}) {
    super();
    this.runtimeConfig = buildRuntimeConfig(process.env, options.runtimeConfig ?? {});
    this.maxConcurrentChecks = positiveInteger(options.maxConcurrentChecks ?? process.env.ADY_BOT_MAX_CONCURRENT_CHECKS, 2);
    this.stopOnAvailable = options.stopOnAvailable ?? parseBoolean(process.env.ADY_BOT_STOP_ON_AVAILABLE, true);
    this.log = options.log ?? ((message) => console.log(message));
  }

  subscribe(requestInput: AdyRequestInput | AdyRequest, subscriberInput: SubscriberInput): SubscriptionResult {
    const request = normalizeRequest(requestInput);
    const key = createScrapeKey(request);
    let job = this.jobs.get(key);
    const created = !job;

    if (!job) {
      job = {
        key,
        request,
        subscribers: new Map(),
        timer: null,
        stopped: false,
        lastRunAt: null,
        createdAt: new Date(),
      };
      this.jobs.set(key, job);
      this.schedule(job, 0);
    }

    const chatId = String(subscriberInput.chatId);
    job.subscribers.set(chatId, {
      chatId,
      userId: subscriberInput.userId ?? '',
      username: subscriberInput.username ?? '',
      maxPrice: request.maxPrice,
      createdAt: new Date(),
    });

    return {
      created,
      job,
      subscriberCount: job.subscribers.size,
    };
  }

  unsubscribeChat(chatId: number | string): number {
    const keysToRemove: string[] = [];
    let removed = 0;

    for (const [key, job] of this.jobs) {
      if (job.subscribers.delete(String(chatId))) {
        removed += 1;
      }

      if (job.subscribers.size === 0) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.stopJob(key);
    }

    return removed;
  }

  getChatJobs(chatId: number | string): ChatJob[] {
    const result: ChatJob[] = [];
    for (const job of this.jobs.values()) {
      const subscriber = job.subscribers.get(String(chatId));
      if (subscriber) {
        result.push({ job, subscriber });
      }
    }
    return result;
  }

  async close(): Promise<void> {
    for (const key of [...this.jobs.keys()]) {
      this.stopJob(key);
    }

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.contextPromise = null;
    }
  }

  private schedule(job: AdyJob, delayMs: number): void {
    if (job.stopped) return;
    if (job.timer) clearTimeout(job.timer);

    job.timer = setTimeout(() => {
      job.timer = null;
      this.runJob(job).catch((error) => {
        this.emit('job-error', { job, error } satisfies JobErrorEvent);
      });
    }, delayMs);

    job.timer.unref?.();
  }

  private stopJob(key: string): boolean {
    const job = this.jobs.get(key);
    if (!job) return false;

    job.stopped = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    this.jobs.delete(key);
    return true;
  }

  private async runJob(job: AdyJob): Promise<void> {
    if (job.stopped || job.subscribers.size === 0) {
      this.stopJob(job.key);
      return;
    }

    await this.runWithLimit(async () => {
      if (job.stopped || job.subscribers.size === 0) return null;
      return this.checkJob(job);
    });

    if (!job.stopped && job.subscribers.size > 0) {
      this.schedule(job, this.runtimeConfig.intervalMs);
    }
  }

  private runWithLimit<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pumpQueue();
    });
  }

  private pumpQueue(): void {
    while (this.activeChecks < this.maxConcurrentChecks && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
      this.activeChecks += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeChecks -= 1;
          this.pumpQueue();
        });
    }
  }

  private async checkJob(job: AdyJob): Promise<void> {
    let page: Page | null = null;

    try {
      const context = await this.ensureContext();
      page = await context.newPage();
      job.lastRunAt = new Date();

      const batch = await runChecks(page, job.request, {
        ...this.runtimeConfig,
        log: (message) => this.log(`[ADY] ${message}`),
      });
      this.handleBatch(job, batch);
      this.emit('checked', {
        job,
        batch,
        nextCheckInMs: this.runtimeConfig.intervalMs,
      } satisfies CheckedEvent);
    } catch (error) {
      this.emit('job-error', { job, error } satisfies JobErrorEvent);
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.contextPromise) {
      this.contextPromise = launchBrowser({
        ...this.runtimeConfig,
        log: (message) => this.log(`[ADY] ${message}`),
      }).then((context) => {
        this.context = context;
        return context;
      }).catch((error) => {
        this.contextPromise = null;
        throw error;
      });
    }

    return this.contextPromise;
  }

  private handleBatch(job: AdyJob, batch: CheckBatch): void {
    for (const subscriber of [...job.subscribers.values()]) {
      const matches = batch.results
        .filter((result): result is TicketsFoundResult => result.status === 'tickets-found' && result.cheapestPrice <= subscriber.maxPrice)
        .sort((left, right) => left.cheapestPrice - right.cheapestPrice);

      if (matches.length === 0) continue;

      this.emit('available', {
        job,
        subscriber,
        matches,
        message: buildAvailableMessage(job.request, matches, subscriber.maxPrice),
      } satisfies AvailableEvent);

      if (this.stopOnAvailable) {
        job.subscribers.delete(String(subscriber.chatId));
      }
    }

    if (job.subscribers.size === 0) {
      this.stopJob(job.key);
    }
  }
}

export function buildAvailableMessage(request: AdyRequest, matches: TicketsFoundResult[], maxPrice: number): string {
  const lines = matches.flatMap((match) => {
    const priceLine = `- ${match.target.displayValue}: ${formatPrice(match.cheapestPrice)} AZN`;
    if (!match.ticketSearchUrl) return [priceLine];
    return [priceLine, `  Link: ${match.ticketSearchUrl}`];
  });
  const hasDeepLink = matches.some((match) => Boolean(match.ticketSearchUrl));

  return [
    'ADY bileti hazır görünür.',
    `${request.from.label || request.from.exact} -> ${request.to.label || request.to.exact}`,
    `${request.adults} nəfər, limit: ${formatPrice(maxPrice)} AZN`,
    '',
    ...lines,
    '',
    hasDeepLink ? 'Linkə klikləyəndə birbaşa bilet seçimi səhifəsi açılmalıdır.' : 'Gir al: https://ticket.ady.az/',
  ].join('\n');
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
