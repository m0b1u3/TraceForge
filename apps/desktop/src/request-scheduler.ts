/** Bounded host-side admission, not a retry mechanism. A read cannot consume
 * the final execution slot; queued commands outrank background observations. */
export class RequestScheduler {
  private closed = false;
  private running = 0;
  private reads = 0;
  private queue: Array<{ write: boolean; urgent: boolean; run(): void; reject(error: Error): void }> = [];
  private shared = new Map<string, Promise<unknown>>();
  schedule<T>(write: boolean, operation: () => Promise<T>, readKey?: string, urgent = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Desktop request scheduler closed"));
    if (!write && readKey && this.shared.has(readKey)) return this.shared.get(readKey)! as Promise<T>;
    if (this.queue.length >= (urgent ? 96 : write ? 80 : 64)) return Promise.reject(new Error("Desktop request queue full"));
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ write, urgent, reject, run: () => {
        this.running++; if (!write) this.reads++;
        void Promise.resolve().then(() => {
          if (this.closed) throw new Error("Desktop request scheduler closed");
          return operation();
        }).then(value => this.closed ? reject(new Error("Desktop request scheduler closed")) : resolve(value), reject)
          .finally(() => { this.running--; if (!write) this.reads--; this.drain(); });
      } });
      this.drain();
    });
    if (!write && readKey) {
      this.shared.set(readKey, promise);
      void promise.then(() => this.shared.delete(readKey), () => this.shared.delete(readKey));
    }
    return promise;
  }
  close() {
    this.closed = true;
    for (const item of this.queue.splice(0)) item.reject(new Error("Desktop request scheduler closed"));
    this.shared.clear();
  }
  private drain() {
    while (!this.closed && this.running < 4) {
      let index = this.queue.findIndex(item => item.urgent);
      if (index < 0 && this.running >= 3) return;
      if (index < 0) index = this.queue.findIndex(item => item.write);
      if (index < 0) index = this.reads < 3 ? this.queue.findIndex(item => !item.write) : -1;
      if (index < 0) return;
      this.queue.splice(index, 1)[0]!.run();
    }
  }
}
