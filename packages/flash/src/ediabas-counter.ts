/**
 * Diagnostic wrapper around an `IEdiabasProvider` that counts every
 * `job(ecu, jobName, ...)` dispatch by name.
 *
 * Used by the FlashSession to surface evidence of whether the IPO
 * actually ran its flash loop — a real flash dispatches
 * `FLASH_SCHREIBEN` once per chunk, so the counter for that job
 * should be in the thousand-ish range for a 256 KB payload.
 *
 * Two layers of counting:
 *
 *   1. `provider.job(ecu, name, arg1, arg2)` — the IPO's INPAapiJob /
 *      CABI CDHapiJob dispatch (string params only).
 *   2. `provider.getEdiabas().job(ecu, name, bytes)` — the binary
 *      escape hatch CDHapiJobData (slot 0x0E) uses to push raw
 *      Uint8Array params into the SGBD's `pary` channel. Pre-
 *      ediabasx 0.7.1 this routed through `Ediabas.executeJob(name,
 *      {params:[Uint8Array]})`; since 0.7.1 it goes through the
 *      widened `IEdiabas.job` directly.
 *
 * The two layers don't double-count: CABI CDHapiJob never escapes
 * past the provider; CDHapiJobData always escapes (the provider's
 * `job` surface is string-only).
 */

import type { IEdiabasProvider } from '@emdzej/inpax-interfaces';
import type { IEdiabas, EdiabasJobResponse } from '@emdzej/ediabasx-core';

export interface EdiabasJobCounters {
  /** Per-(ecu, job) call counts (provider.job path — string params). */
  byKey: Map<string, number>;
  /** Per-job-name totals (sum across all ECUs/SGBDs). */
  byJob: Map<string, number>;
  /** Total wall-clock spent inside provider.job dispatches. */
  totalMs: number;
  /**
   * Binary-path dispatches via `getEdiabas().job(ecu, job, bytes)`.
   * `CDHapiJobData` (slot 0x0E) uses this path — it bypasses
   * `provider.job()` entirely (the provider surface is string-only),
   * so we must instrument the underlying IEdiabas separately.
   */
  binByJob: Map<string, number>;
  /** Total bytes pushed via the binary path (sum of param sizes). */
  binBytesPushed: number;
  /** Total wall-clock spent inside binary `IEdiabas.job()` calls. */
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
      // `getEdiabas()` returns the underlying IEdiabas used by the
      // binary-payload path (`CDHapiJobData` → `IEdiabas.job` with
      // Uint8Array params). Wrap it too so FLASH_SCHREIBEN counts.
      if (prop === 'getEdiabas') {
        const fn = (target as unknown as { getEdiabas?: () => unknown }).getEdiabas;
        if (typeof fn !== 'function') return undefined;
        return () => {
          const ed = fn.call(target);
          if (!ed || typeof (ed as { job?: unknown }).job !== 'function') {
            return ed;
          }
          return wrapIEdiabas(ed as IEdiabas, counters);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Count binary-channel dispatches and bytes pushed through an
 * `IEdiabas` instance. The provider's `getEdiabas()` accessor
 * surfaces this — we wrap the returned IEdiabas so CDHapiJobData's
 * binary writes get tallied even though they bypass
 * `provider.job()`.
 *
 * Only counts when params include a `Uint8Array` — pure-string
 * dispatches that happen to also go through this surface (rare, but
 * possible if a caller bypasses the provider) keep the bin counters
 * at zero.
 */
function wrapIEdiabas(ed: IEdiabas, counters: EdiabasJobCounters): IEdiabas {
  return new Proxy(ed, {
    get(target, prop) {
      if (prop === 'job') {
        return async (
          ecu: string,
          jobName: string,
          params?: string | Uint8Array | (string | Uint8Array)[],
        ): Promise<EdiabasJobResponse> => {
          let bytesThisCall = 0;
          if (params instanceof Uint8Array) {
            bytesThisCall = params.length;
          } else if (Array.isArray(params)) {
            for (const p of params) {
              if (p instanceof Uint8Array) bytesThisCall += p.length;
            }
          }
          /* Only count when there's actually binary in flight. The
             same getEdiabas path is also reachable for string-only
             dispatches (some callers prefer it for the wider
             IEdiabas surface); those keep `binByJob` clean. */
          if (bytesThisCall > 0) {
            counters.binByJob.set(jobName, (counters.binByJob.get(jobName) ?? 0) + 1);
            counters.binBytesPushed += bytesThisCall;
          }
          const t0 = Date.now();
          try {
            return await target.job(ecu, jobName, params);
          } finally {
            if (bytesThisCall > 0) counters.binTotalMs += Date.now() - t0;
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
