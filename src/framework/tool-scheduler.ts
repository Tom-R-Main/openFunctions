/** One scheduling domain shared by an executor and all its registry projections. */
export type ToolSchedulingMode = "parallel-safe" | "exclusive";

export interface ToolScheduleOptions {
  signal?: AbortSignal;
  /** Absolute deadline in milliseconds since the epoch. */
  deadline?: number | Date;
  clock?: () => number;
}

/** A private capability given only to the operation holding a reservation. */
export interface BoundToolScheduler {
  run<T>(
    mode: ToolSchedulingMode,
    operation: (child: BoundToolScheduler) => Promise<T>,
    options?: ToolScheduleOptions,
  ): Promise<T>;
}

type Entry = {
  mode: ToolSchedulingMode;
  options: ToolScheduleOptions;
  start: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

function admissionError(options: ToolScheduleOptions): unknown | undefined {
  if (options.signal?.aborted) {
    return options.signal.reason ?? new DOMException("Tool execution cancelled", "AbortError");
  }
  const deadline = options.deadline instanceof Date
    ? options.deadline.getTime() : options.deadline;
  if (deadline !== undefined && (!Number.isFinite(deadline)
    || (options.clock ?? Date.now)() >= deadline)) {
    return new DOMException("Tool execution deadline exceeded", "TimeoutError");
  }
  return undefined;
}

export class ToolScheduler {
  readonly maxParallel: number;
  private queue: Entry[] = [];
  private readers = 0;
  private writer = false;

  constructor(options: { maxParallel?: number } = {}) {
    const cap = options.maxParallel ?? 4;
    this.maxParallel = Number.isFinite(cap) && Number.isInteger(cap) && cap > 0 ? cap : 1;
  }

  /** FIFO admission: an exclusive entry is a barrier for all later readers. */
  run<T>(
    mode: ToolSchedulingMode,
    operation: (child: BoundToolScheduler) => Promise<T>,
    options: ToolScheduleOptions = {},
  ): Promise<T> {
    const error = admissionError(options);
    if (error !== undefined) return Promise.reject(error);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return; // Once admitted, cancellation must not erase its result.
        this.queue.splice(index, 1);
        entry.cleanup();
        reject(admissionError(options) ?? new DOMException("Tool execution cancelled", "AbortError"));
        this.drain();
      };
      const entry: Entry = {
        mode, options, reject,
        cleanup: () => {
          options.signal?.removeEventListener("abort", cancel);
          if (timer !== undefined) clearTimeout(timer);
        },
        start: () => {
          entry.cleanup();
          if (mode === "exclusive") this.writer = true;
          else this.readers += 1;
          void this.withReservation(mode, operation, options).then(resolve, reject).finally(() => {
            if (mode === "exclusive") this.writer = false;
            else this.readers -= 1;
            this.drain();
          });
        },
      };
      this.queue.push(entry);
      options.signal?.addEventListener("abort", cancel, { once: true });
      const deadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
      if (deadline !== undefined) {
        const checkDeadline = () => {
          const delay = deadline - (options.clock ?? Date.now)();
          if (delay <= 0) cancel();
          else {
            timer = setTimeout(checkDeadline, Math.min(delay, 2_147_483_647));
            timer.unref?.();
          }
        };
        checkDeadline();
      }
      this.drain();
    });
  }

  private drain(): void {
    if (this.writer) return;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      const error = admissionError(next.options);
      if (error !== undefined) {
        this.queue.shift();
        next.cleanup();
        next.reject(error);
        continue;
      }
      if (next.mode === "exclusive") {
        if (this.readers > 0) return;
        this.queue.shift();
        next.start();
        return;
      }
      if (this.readers >= this.maxParallel) return;
      this.queue.shift();
      next.start();
    }
  }

  private async withReservation<T>(
    mode: ToolSchedulingMode,
    operation: (child: BoundToolScheduler) => Promise<T>,
    inherited: ToolScheduleOptions,
  ): Promise<T> {
    let active = true;
    // Siblings share one slot and run in order. Descendants use their own
    // bound capability, so a parent awaiting its child never queues behind itself.
    let tail: Promise<unknown> = Promise.resolve();
    const bound: BoundToolScheduler = Object.freeze({
      run: <R>(childMode: ToolSchedulingMode, childOperation: (child: BoundToolScheduler) => Promise<R>, options: ToolScheduleOptions = {}) => {
        if (!active) return Promise.reject(new Error("Tool reservation is no longer active"));
        if (mode === "parallel-safe" && childMode === "exclusive") {
          return Promise.reject(new Error("Cannot upgrade a parallel-safe reservation to exclusive"));
        }
        const parentDeadline = inherited.deadline instanceof Date ? inherited.deadline.getTime() : inherited.deadline;
        const childDeadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
        const signals = [inherited.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
        const opts: ToolScheduleOptions = {
          ...inherited, ...options,
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
          ...(parentDeadline === undefined ? {} : {
            deadline: childDeadline === undefined ? parentDeadline : Math.min(parentDeadline, childDeadline),
            clock: inherited.clock,
          }),
        };
        const scheduled = tail.then(() => {
          const error = admissionError(opts);
          if (error !== undefined) throw error;
          return this.withReservation(childMode, childOperation, opts);
        });
        tail = scheduled.catch(() => undefined);
        return scheduled;
      },
    });
    try {
      return await operation(bound);
    } finally {
      active = false;
      await tail;
    }
  }
}
