/**
 * Diagnostic wrapper around an `IEdiabasProvider` that counts every
 * `job(ecu, jobName, ...)` dispatch by name.
 *
 * Used by the FlashSession to surface evidence of whether the IPO
 * actually ran its flash loop — a real flash dispatches
 * `FLASH_SCHREIBEN` once per chunk, so the counter for that job
 * should be in the thousand-ish range for a 256 KB payload.
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';

export interface EdiabasJobCounters {
  /** Per-(ecu, job) call counts. */
  byKey: Map<string, number>;
  /** Per-job-name totals (sum across all ECUs/SGBDs). */
  byJob: Map<string, number>;
  /** Total wall-clock spent inside `job()` across all dispatches. */
  totalMs: number;
  /**
   * Binary-path dispatches via `getEdiabas().executeJob(job, { params: [bytes] })`.
   * `CDHapiJobData` (slot 0x0E) uses this path — it bypasses `provider.job()`
   * entirely, so we must instrument the underlying `Ediabas` separately.
   */
  binByJob: Map<string, number>;
  /** Total bytes pushed via the binary path (sum of param sizes). */
  binBytesPushed: number;
  /** Total wall-clock spent inside binary `executeJob()` calls. */
  binTotalMs: number;
}

/**
 * Wrap `inner` so every `job()` call is counted into `counters`.
 * All other methods pass through unchanged.
 *
 * Uses a `Proxy` so we don't have to forward every method/property —
 * `IEdiabasProvider` extends `EventEmitter`, which has a wide and
 * private surface that's hard to subclass cleanly.
 */
export function wrapWithJobCounter(
  inner: IEdiabasProvider,
  counters: EdiabasJobCounters,
): IEdiabasProvider {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'job') {
        return async (ecu: string, job: string, arg1: string, arg2: string) => {
          const key = `${ecu}::${job}`;
          counters.byKey.set(key, (counters.byKey.get(key) ?? 0) + 1);
          counters.byJob.set(job, (counters.byJob.get(job) ?? 0) + 1);
          const t0 = Date.now();
          try {
            await target.job(ecu, job, arg1, arg2);
          } finally {
            counters.totalMs += Date.now() - t0;
          }
        };
      }
      // `getEdiabas()` returns the underlying Ediabas instance used by
      // the binary-payload path (`CDHapiJobData` → `executeJob`).
      // Wrap that too so FLASH_SCHREIBEN counts.
      if (prop === 'getEdiabas') {
        const fn = (target as unknown as { getEdiabas?: () => unknown }).getEdiabas;
        if (typeof fn !== 'function') return undefined;
        return () => {
          const ed = fn.call(target);
          if (!ed || typeof (ed as { executeJob?: unknown }).executeJob !== 'function') {
            return ed;
          }
          return wrapEdiabasInstance(ed as EdiabasLike, counters);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface EdiabasLike {
  loadSgbd(filename: string): Promise<void>;
  executeJob(
    jobName: string,
    options?: { params?: (string | Uint8Array)[]; timeout?: number },
  ): Promise<Array<Array<{ name: string; value: unknown }>>>;
}

function wrapEdiabasInstance(ed: EdiabasLike, counters: EdiabasJobCounters): EdiabasLike {
  return new Proxy(ed, {
    get(target, prop) {
      if (prop === 'executeJob') {
        return async (
          jobName: string,
          options?: { params?: (string | Uint8Array)[]; timeout?: number },
        ) => {
          counters.binByJob.set(jobName, (counters.binByJob.get(jobName) ?? 0) + 1);
          const params = options?.params ?? [];
          for (const p of params) {
            if (p instanceof Uint8Array) counters.binBytesPushed += p.length;
          }
          const t0 = Date.now();
          try {
            return await target.executeJob(jobName, options);
          } finally {
            counters.binTotalMs += Date.now() - t0;
          }
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function newEdiabasJobCounters(): EdiabasJobCounters {
  return {
    byKey: new Map(),
    byJob: new Map(),
    totalMs: 0,
    binByJob: new Map(),
    binBytesPushed: 0,
    binTotalMs: 0,
  };
}
