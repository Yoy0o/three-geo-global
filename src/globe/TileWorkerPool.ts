import type { TerrainSource } from './terrain/TerrainSource';
import type { BuildTileRequest, BuiltTile, WorkerResponse } from './workerProtocol';

interface PendingJob {
  resolve: (tile: BuiltTile) => void;
  reject: (err: Error) => void;
  worker: number;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Small pool of mesh-building workers with optional cache affinity. */
export class TileWorkerPool {
  private workers: Worker[] = [];
  private load: number[] = [];
  private jobs = new Map<number, PendingJob>();
  private nextId = 1;
  private readonly registered = new WeakSet<TerrainSource>();

  constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./tileMesh.worker.ts', import.meta.url), { type: 'module', name: `tile-mesh-${i}` });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
      worker.onerror = (event) => console.error('[TileWorkerPool] worker error', event.message);
      this.workers.push(worker);
      this.load.push(0);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Sends a terrain source description to every worker once (requests then refer to it by id). */
  registerTerrain(source: TerrainSource): void {
    if (this.registered.has(source)) return;
    this.registered.add(source);
    for (const w of this.workers) w.postMessage({ type: 'source', source });
  }

  /**
   * Builds a tile mesh. `affinityKey` routes jobs that share cached source
   * data (e.g. the same terrain ancestor) to the same worker.
   */
  build(params: Omit<BuildTileRequest, 'type' | 'id'>, signal?: AbortSignal, affinityKey?: string): Promise<BuiltTile> {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    let index = 0;
    if (affinityKey) {
      index = hashString(affinityKey) % this.workers.length;
    } else {
      for (let i = 1; i < this.load.length; i++) if (this.load[i] < this.load[index]) index = i;
    }
    return new Promise<BuiltTile>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, worker: index });
      this.load[index]++;
      const request: BuildTileRequest = { type: 'build', id, ...params };
      this.workers[index].postMessage(request);
      signal?.addEventListener(
        'abort',
        () => {
          if (this.jobs.has(id)) this.workers[index].postMessage({ type: 'cancel', id });
        },
        { once: true },
      );
    });
  }

  private onMessage(msg: WorkerResponse): void {
    const job = this.jobs.get(msg.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    this.load[job.worker]--;
    if (msg.type === 'built') job.resolve(msg);
    else job.reject(msg.aborted ? abortError() : new Error(msg.message));
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const job of this.jobs.values()) job.reject(abortError());
    this.jobs.clear();
    this.workers = [];
  }
}
