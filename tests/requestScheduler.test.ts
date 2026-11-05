import { describe, expect, it } from 'vitest';
import { hostLoad, hostOf, scheduleRequest } from '../src/globe/imagery/RequestScheduler';

/** A request that resolves when told to. */
function deferred() {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('request scheduler', () => {
  it('parses hosts', () => {
    expect(hostOf('https://server.arcgisonline.com/ArcGIS/rest/x')).toBe('server.arcgisonline.com');
    expect(hostOf('http://localhost:8080/a.png')).toBe('localhost:8080');
    expect(hostOf('not a url')).toBe('');
  });

  it('runs at most `limit` requests per host, the rest in order', async () => {
    const host = 'limit.test';
    const jobs = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    const results = jobs.map((job, i) =>
      scheduleRequest(host, { limit: 2 }, () => {
        started.push(i);
        return job.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(hostLoad(host)).toMatchObject({ active: 2, waiting: 3 });
    jobs[1].resolve('b');
    await tick();
    expect(started).toEqual([0, 1, 2]);
    jobs[0].resolve('a');
    jobs[2].resolve('c');
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    jobs[3].resolve('d');
    jobs[4].resolve('e');
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
  });

  it('drops waiting requests at once when aborted, without starting them', async () => {
    const host = 'abort.test';
    const first = deferred();
    const controller = new AbortController();
    let secondStarted = false;
    const a = scheduleRequest(host, { limit: 1 }, () => first.promise);
    const b = scheduleRequest(host, { limit: 1, signal: controller.signal }, async () => {
      secondStarted = true;
      return 'b';
    });
    await tick();
    controller.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(hostLoad(host).waiting).toBe(0);
    first.resolve('a');
    expect(await a).toBe('a');
    expect(secondStarted).toBe(false);
    expect(hostLoad(host).active).toBe(0);
  });

  it('rejects requests aborted before scheduling', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scheduleRequest('pre.test', { limit: 1, signal: controller.signal }, async () => 'x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lets started requests finish unless asked to abort them', async () => {
    const controller = new AbortController();
    let given: AbortSignal | undefined;
    const job = deferred();
    const r = scheduleRequest('started.test', { limit: 1, signal: controller.signal }, (s) => {
      given = s;
      return job.promise;
    });
    await tick();
    expect(given).toBeUndefined();
    controller.abort();
    job.resolve('done');
    expect(await r).toBe('done');

    let forwarded: AbortSignal | undefined;
    const c2 = new AbortController();
    await scheduleRequest('started.test', { limit: 1, signal: c2.signal, abortStarted: true }, async (s) => (forwarded = s));
    expect(forwarded).toBe(c2.signal);
  });

  it('frees the slot when a request fails', async () => {
    const host = 'fail.test';
    await expect(scheduleRequest(host, { limit: 1 }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
    expect(await scheduleRequest(host, { limit: 1 }, async () => 'ok')).toBe('ok');
  });
});
