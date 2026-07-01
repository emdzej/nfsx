/**
 * Thin wrapper over IEdiabas.job() for MS45's SGBD-driven flow.
 *
 * The C# reference uses two helpers:
 *
 *   ExecuteJob(ediabas, job, arg) → bool     (arg is string or byte[])
 *   GetResult_String(name, resultSets)       (walks all sets, returns
 *                                             the last string match)
 *   GetResult_ByteArray(name, resultSets)    (same for byte[])
 *
 * Both helpers gate on `JOB_STATUS == "OKAY"` from the system result
 * set. We mirror that here, in TypeScript, over `EdiabasJobResponse`.
 * Errors surface as `Ms45JobError` — callers pattern-match on the
 * failing job name to give the operator a useful message.
 */

import type {
  IEdiabas,
  EdiabasJobResponse,
  EdiabasResultSet,
} from '@emdzej/ediabasx-core';

export type SgbdArg = string | Uint8Array;

export class Ms45JobError extends Error {
  constructor(
    message: string,
    public readonly job: string,
    public readonly jobStatus: string | null,
  ) {
    super(`ms45 job ${job}: ${message}`);
    this.name = 'Ms45JobError';
  }
}

/**
 * Dispatch a single SGBD job, throw on non-OKAY JOB_STATUS.
 *
 * Some MS45 jobs (e.g. `authentisierung_start`) never fill a data
 * set at all — a bare `JOB_STATUS: OKAY` is the entire response. Others
 * publish exactly one data set. We hand the raw response back so the
 * caller can pick what they need.
 */
export async function runJob(
  ediabas: IEdiabas,
  sgbd: string,
  jobName: string,
  arg?: SgbdArg,
): Promise<EdiabasJobResponse> {
  let response: EdiabasJobResponse;
  try {
    response = await ediabas.job(sgbd, jobName, arg);
  } catch (err) {
    const status = tryReadJobStatus(err);
    throw new Ms45JobError((err as Error).message ?? String(err), jobName, status);
  }
  const status = getJobStatus(response);
  if (status !== 'OKAY') {
    throw new Ms45JobError(`JOB_STATUS=${status ?? '<missing>'}`, jobName, status);
  }
  return response;
}

/**
 * Extract JOB_STATUS from a response. Lives in the system set (index 0
 * per `EdiabasJobResponse.sets`), but a defensive scan of every set
 * matches the C# helper's behavior and is trivially cheap.
 */
export function getJobStatus(response: EdiabasJobResponse): string | null {
  for (const set of response.sets) {
    const entry = set['JOB_STATUS'];
    if (entry && typeof entry.value === 'string') return entry.value;
  }
  return null;
}

function tryReadJobStatus(err: unknown): string | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as { response: unknown }).response === 'object'
  ) {
    return getJobStatus((err as { response: EdiabasJobResponse }).response);
  }
  return null;
}

// ── typed result extractors ────────────────────────────────────────

function eachSet(response: EdiabasJobResponse): Iterable<EdiabasResultSet> {
  return response.sets;
}

/** Find the last string result with the given name across all sets. */
export function getResultString(
  response: EdiabasJobResponse,
  name: string,
): string | null {
  let last: string | null = null;
  for (const set of eachSet(response)) {
    const entry = set[name];
    if (entry && typeof entry.value === 'string') last = entry.value;
  }
  return last;
}

/** Find the last binary result with the given name across all sets. */
export function getResultBinary(
  response: EdiabasJobResponse,
  name: string,
): Uint8Array | null {
  let last: Uint8Array | null = null;
  for (const set of eachSet(response)) {
    const entry = set[name];
    if (!entry) continue;
    if (entry.type === 'binary' && Array.isArray(entry.value)) {
      last = new Uint8Array(entry.value);
    }
  }
  return last;
}

/**
 * Convenience: string result or throw with a caller-supplied name.
 * Used for identity job outputs where an absent field is a hard error.
 */
export function requireResultString(
  response: EdiabasJobResponse,
  jobName: string,
  resultName: string,
): string {
  const v = getResultString(response, resultName);
  if (v === null) {
    throw new Ms45JobError(
      `missing string result "${resultName}"`,
      jobName,
      getJobStatus(response),
    );
  }
  return v;
}

/** Convenience: binary result or throw. */
export function requireResultBinary(
  response: EdiabasJobResponse,
  jobName: string,
  resultName: string,
): Uint8Array {
  const v = getResultBinary(response, resultName);
  if (v === null) {
    throw new Ms45JobError(
      `missing binary result "${resultName}"`,
      jobName,
      getJobStatus(response),
    );
  }
  return v;
}
