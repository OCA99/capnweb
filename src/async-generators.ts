// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import {
  StubHook, RpcPayload, PropertyPath, ErrorStubHook, PayloadStubHook, PromiseStubHook,
  asyncGeneratorImpl
} from "./core.js";

type AsyncGeneratorState = {
  refcount: number;
  generator: AsyncGenerator;
  closed: boolean;
};

class AsyncGeneratorStubHook extends StubHook {
  private state?: AsyncGeneratorState;

  static create(gen: AsyncGenerator): AsyncGeneratorStubHook {
    return new AsyncGeneratorStubHook({ refcount: 1, generator: gen, closed: false });
  }

  private constructor(state: AsyncGeneratorState, dupFrom?: AsyncGeneratorStubHook) {
    super();
    this.state = state;
    if (dupFrom) {
      ++state.refcount;
    }
  }

  private getState(): AsyncGeneratorState {
    if (this.state) {
      return this.state;
    } else {
      throw new Error("Attempted to use an AsyncGeneratorStubHook after it was disposed.");
    }
  }

  private invokeMethod(method: string, args: RpcPayload): StubHook {
    try {
      let state = this.getState();
      let func: ((...args: any[]) => Promise<unknown>);

      switch (method) {
        case "next":
          func = async (value: unknown) => {
            let result = await state.generator.next(value);
            if (result.done) state.closed = true;
            return result;
          };
          break;

        case "return":
          func = async (value: unknown) => {
            let result = await state.generator.return(value);
            if (result.done) state.closed = true;
            return result;
          };
          break;

        case "throw":
          func = async (error: unknown) => {
            let result = await state.generator.throw(error);
            if (result.done) state.closed = true;
            return result;
          };
          break;

        case "nextBatch":
          func = async (want: unknown) => {
            if (!Number.isInteger(want) || <number>want <= 0) {
              throw new TypeError("nextBatch() expects a positive integer.");
            }

            let result: IteratorResult<unknown>[] = [];
            for (let i = 0; i < <number>want; i++) {
              let item = await state.generator.next(undefined);
              result.push(item);
              if (item.done) {
                state.closed = true;
                break;
              }
            }
            return result;
          };
          break;

        default:
          args.dispose();
          return new ErrorStubHook(new Error(`Unknown AsyncGenerator method: ${method}`));
      }

      let promise = args.deliverCall(func, undefined);
      return new PromiseStubHook(promise.then(payload => new PayloadStubHook(payload)));
    } catch (err) {
      return new ErrorStubHook(err);
    }
  }

  call(path: PropertyPath, args: RpcPayload): StubHook {
    if (path.length !== 1 || typeof path[0] !== "string") {
      args.dispose();
      return new ErrorStubHook(
          new Error("AsyncGenerator stubs only support direct next/return/throw/nextBatch calls."));
    }
    return this.invokeMethod(path[0], args);
  }

  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook {
    for (let cap of captures) {
      cap.dispose();
    }
    return new ErrorStubHook(new Error("Cannot use map() on an AsyncGenerator"));
  }

  get(path: PropertyPath): StubHook {
    return new ErrorStubHook(new Error("Cannot access properties on an AsyncGenerator stub"));
  }

  dup(): StubHook {
    let state = this.getState();
    return new AsyncGeneratorStubHook(state, this);
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    return Promise.reject(new Error("Cannot pull an AsyncGenerator stub"));
  }

  ignoreUnhandledRejections(): void {
    // Nothing to do.
  }

  dispose(): void {
    let state = this.state;
    this.state = undefined;
    if (state) {
      if (--state.refcount === 0) {
        if (!state.closed) {
          state.generator.return(undefined).catch(() => {});
          state.closed = true;
        }
      }
    }
  }

  onBroken(callback: (error: any) => void): void {
    // AsyncGenerator stubs don't have a separate "broken" channel.
  }
}

export type RpcConsumeOptions = {
  maxBufferedItems?: number;
  minBufferedItems?: number;
  refillItems?: number;
  prefetchOnStart?: boolean;
  signal?: AbortSignal;
}

type NormalizedConsumeOptions = {
  maxBufferedItems: number;
  minBufferedItems: number;
  refillItems: number;
  prefetchOnStart: boolean;
  signal?: AbortSignal;
}

const STRICT_OPTIONS: NormalizedConsumeOptions = {
  maxBufferedItems: 1,
  minBufferedItems: 0,
  refillItems: 1,
  prefetchOnStart: false,
};

const DEFAULT_CONSUME_OPTIONS: NormalizedConsumeOptions = {
  maxBufferedItems: 128,
  minBufferedItems: 32,
  refillItems: 64,
  prefetchOnStart: true,
};

function normalizeOptions(options: RpcConsumeOptions | undefined,
                          base: NormalizedConsumeOptions): NormalizedConsumeOptions {
  let merged: NormalizedConsumeOptions = {
    ...base,
    ...options,
  };
  merged.maxBufferedItems = Math.max(1, Math.floor(merged.maxBufferedItems));
  merged.minBufferedItems = Math.max(0, Math.floor(merged.minBufferedItems));
  merged.refillItems = Math.max(1, Math.floor(merged.refillItems));
  if (merged.minBufferedItems >= merged.maxBufferedItems) {
    merged.minBufferedItems = merged.maxBufferedItems - 1;
  }
  return merged;
}

type BatchDisposerState = {
  remaining: number;
  disposed: boolean;
  dispose: () => void;
}

function addBatchItemDisposers(batch: IteratorResult<unknown>[]) {
  let batchDispose = (<any>batch)[Symbol.dispose];
  if (typeof batchDispose !== "function") return;

  if (batch.length === 0) {
    batchDispose.call(batch);
    return;
  }

  let state: BatchDisposerState = {
    remaining: batch.length,
    disposed: false,
    dispose: () => batchDispose.call(batch),
  };
  let release = () => {
    if (!state.disposed && --state.remaining === 0) {
      state.disposed = true;
      state.dispose();
    }
  };

  for (let item of batch) {
    if (!(item instanceof Object)) {
      release();
      continue;
    }

    let existingDispose = (<any>item)[Symbol.dispose];
    Object.defineProperty(item, Symbol.dispose, {
      value: () => {
        try {
          if (typeof existingDispose === "function") {
            existingDispose.call(item);
          }
        } finally {
          release();
        }
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

function disposeBatch(batch: IteratorResult<unknown>[]) {
  for (let item of batch) {
    if (item instanceof Object && Symbol.dispose in item) {
      (<Disposable><any>item)[Symbol.dispose]();
    }
  }
}

class RemoteAsyncGeneratorEngine {
  private options: NormalizedConsumeOptions = STRICT_OPTIONS;
  private consumeModeEnabled = false;
  private inFlightRefill?: Promise<void>;
  private buffer: IteratorResult<unknown>[] = [];
  private done = false;
  private closed = false;
  private error: any = undefined;
  private signalCleanup?: () => void;

  constructor(private hook: StubHook) {}

  consume(options?: RpcConsumeOptions) {
    if (this.closed) return;

    let base = this.consumeModeEnabled ? this.options : DEFAULT_CONSUME_OPTIONS;
    if (!options) base = DEFAULT_CONSUME_OPTIONS;
    this.options = normalizeOptions(options, base);
    this.consumeModeEnabled = true;

    this.attachSignal(this.options.signal);

    if (this.options.prefetchOnStart) {
      this.maybeRefill();
    }
  }

  private attachSignal(signal: AbortSignal | undefined) {
    if (this.signalCleanup) {
      this.signalCleanup();
      this.signalCleanup = undefined;
    }
    if (!signal) return;

    if (signal.aborted) {
      this.error = signal.reason ?? new Error("AsyncGenerator consumption was aborted.");
      this.closed = true;
      this.done = true;
      this.clearBuffer();
      return;
    }

    let onAbort = () => {
      this.error = signal.reason ?? new Error("AsyncGenerator consumption was aborted.");
      this.closed = true;
      this.done = true;
      this.clearBuffer();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.signalCleanup = () => signal.removeEventListener("abort", onAbort);
  }

  private clearBuffer() {
    for (let item of this.buffer) {
      if (item instanceof Object && Symbol.dispose in item) {
        (<Disposable><any>item)[Symbol.dispose]();
      }
    }
    this.buffer = [];
  }

  private async invokeRemote(path: PropertyPath, args: unknown[]): Promise<unknown> {
    let resultHook = this.hook.call(path, RpcPayload.fromAppParams(args));
    let pulled = resultHook.pull();
    let payload = pulled instanceof Promise ? await pulled : pulled;
    return payload.deliverResolve();
  }

  private async invokeNext(value: unknown): Promise<IteratorResult<unknown>> {
    return <IteratorResult<unknown>>await this.invokeRemote(["next"], [value]);
  }

  private async invokeReturn(value: unknown): Promise<IteratorResult<unknown>> {
    return <IteratorResult<unknown>>await this.invokeRemote(["return"], [value]);
  }

  private async invokeThrow(value: unknown): Promise<IteratorResult<unknown>> {
    return <IteratorResult<unknown>>await this.invokeRemote(["throw"], [value]);
  }

  private async invokeNextBatch(want: number): Promise<IteratorResult<unknown>[]> {
    let result = await this.invokeRemote(["nextBatch"], [want]);
    if (!(result instanceof Array)) {
      throw new TypeError("nextBatch() did not return an array.");
    }
    addBatchItemDisposers(result as IteratorResult<unknown>[]);
    return <IteratorResult<unknown>[]>result;
  }

  private async maybeRefill(force: boolean = false) {
    if (this.inFlightRefill) {
      await this.inFlightRefill;
      return;
    }
    if (this.closed || this.done || this.error !== undefined) return;

    if (!force && this.buffer.length >= this.options.minBufferedItems) return;

    let room = this.options.maxBufferedItems - this.buffer.length;
    if (room <= 0) return;
    let want = Math.min(room, this.options.refillItems);
    if (want <= 0) return;

    this.inFlightRefill = this.invokeNextBatch(want).then(batch => {
      if (this.closed || this.done || this.error !== undefined) {
        disposeBatch(batch);
        return;
      }
      for (let item of batch) {
        this.buffer.push(item);
        if (item.done) {
          this.done = true;
          break;
        }
      }
    }, err => {
      this.error = err;
    }).finally(() => {
      this.inFlightRefill = undefined;
    });

    await this.inFlightRefill;
  }

  async next(value: unknown): Promise<IteratorResult<unknown>> {
    if (this.error !== undefined) throw this.error;
    if (this.closed) return { done: true, value: undefined };
    if (this.done && this.buffer.length === 0) return { done: true, value: undefined };

    if (value !== undefined) {
      if (this.buffer.length > 0 || this.inFlightRefill) {
        throw new Error(
            "next(value) cannot be used when consumed items are buffered or refilling in flight.");
      }
      let result = await this.invokeNext(value);
      if (result.done) {
        this.done = true;
        this.dispose();
      }
      return result;
    }

    if (this.buffer.length === 0) {
      await this.maybeRefill(true);
    }

    if (this.error !== undefined) throw this.error;
    if (this.buffer.length === 0) return { done: true, value: undefined };

    let result = this.buffer.shift()!;
    if (result.done) {
      this.done = true;
      this.clearBuffer();
      this.dispose();
      return result;
    }

    void this.maybeRefill(false);
    return result;
  }

  async return(value: unknown): Promise<IteratorResult<unknown>> {
    if (this.closed) return { done: true, value };

    this.closed = true;
    this.done = true;
    this.clearBuffer();

    try {
      return await this.invokeReturn(value);
    } finally {
      this.dispose();
    }
  }

  async throw(value: unknown): Promise<IteratorResult<unknown>> {
    if (this.closed) throw value;

    this.clearBuffer();

    let result = await this.invokeThrow(value);
    if (result.done) {
      this.done = true;
      this.closed = true;
      this.dispose();
    }
    return result;
  }

  dispose() {
    this.closed = true;
    this.done = true;
    this.clearBuffer();
    if (this.signalCleanup) {
      this.signalCleanup();
      this.signalCleanup = undefined;
    }
    this.hook.dispose();
  }
}

type RpcAsyncGeneratorRuntime = AsyncGenerator & {
  consume(options?: RpcConsumeOptions): AsyncGenerator;
};

function createAsyncGeneratorFromHook(hook: StubHook): AsyncGenerator {
  let engine = new RemoteAsyncGeneratorEngine(hook);

  let native = (async function* () {})();
  let result = <RpcAsyncGeneratorRuntime><unknown>native;

  Object.defineProperty(result, "next", {
    value: (value?: unknown) => engine.next(value),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(result, "return", {
    value: (value?: unknown) => engine.return(value),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(result, "throw", {
    value: (value?: unknown) => engine.throw(value),
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(result, "consume", {
    value: (options?: RpcConsumeOptions) => {
      engine.consume(options);
      return result;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(result, Symbol.asyncIterator, {
    value: () => result,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  let existingDispose = (<any>result)[Symbol.dispose];
  Object.defineProperty(result, Symbol.dispose, {
    value: () => {
      try {
        if (typeof existingDispose === "function") {
          existingDispose.call(result);
        }
      } finally {
        engine.dispose();
      }
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return result;
}

// Install the implementations into asyncGeneratorImpl
asyncGeneratorImpl.createAsyncGeneratorHook = AsyncGeneratorStubHook.create;
asyncGeneratorImpl.createAsyncGeneratorFromHook = createAsyncGeneratorFromHook;

export function forceInitAsyncGenerators() {}
