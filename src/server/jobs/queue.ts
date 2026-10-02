/**
 * Minimal in-process job queue for CPU-heavy media work (previews, transcodes).
 * Work survives the HTTP request that scheduled it. On serverless platforms swap
 * this for a durable queue (e.g. SQS, Cloud Tasks) behind the same `enqueue` API.
 */
type Job = { name: string; run: () => Promise<void> };

class JobQueue {
  private queue: Job[] = [];
  private active = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  enqueue(name: string, run: () => Promise<void>) {
    this.queue.push({ name, run });
    this.pump();
  }

  /** Resolves once every queued job has finished (used by seeds and tests). */
  onIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      job
        .run()
        .catch((error) => console.error(`[forge] job "${job.name}" failed`, error))
        .finally(() => {
          this.active -= 1;
          if (this.active === 0 && this.queue.length === 0) {
            const resolvers = this.idleResolvers.splice(0);
            resolvers.forEach((resolve) => resolve());
          }
          this.pump();
        });
    }
  }
}

const g = globalThis as unknown as { __forgeMediaQueue?: JobQueue };
export const mediaQueue: JobQueue = (g.__forgeMediaQueue ??= new JobQueue(2));
