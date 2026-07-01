/**
 * In-memory MockIEdiabas for testing MS45 session logic without
 * touching a real cable or EDIABAS install.
 *
 * Register canned responses with `setResponse(job, args?, response)`.
 * Any dispatched `job(sgbd, name, arg)` picks the most-specific match:
 *
 *   1. exact match on (job + arg)  — arg compared by value
 *   2. exact match on (job)        — args ignored
 *   3. throws — no match, useful signal in test failures
 *
 * Every dispatch is recorded in `calls`, in-order, so tests can
 * assert on the exact SGBD choreography.
 */

import type {
  IEdiabas,
  EdiabasJobResponse,
  EdiabasResultEntry,
  EdiabasResultSet,
  EdiabasResultType,
  EdiabasState,
} from '@emdzej/ediabasx-core';

export interface MockCall {
  ecu: string;
  job: string;
  arg: string | Uint8Array | (string | Uint8Array)[] | undefined;
}

type Responder =
  | EdiabasJobResponse
  | ((arg: MockCall['arg']) => EdiabasJobResponse);

interface Registration {
  arg: MockCall['arg'] | undefined;
  responder: Responder;
}

function argsEqual(a: MockCall['arg'], b: MockCall['arg']): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

export class MockIEdiabas implements IEdiabas {
  readonly calls: MockCall[] = [];
  private readonly registrations = new Map<string, Registration[]>();
  /** Optional per-call hook so tests can inject side effects. */
  onCall?: (call: MockCall) => void;

  /** Register a canned response for a job name (optionally an exact arg match). */
  setResponse(
    job: string,
    arg: MockCall['arg'] | undefined,
    response: Responder,
  ): void {
    const list = this.registrations.get(job) ?? [];
    list.push({ arg, responder: response });
    this.registrations.set(job, list);
  }

  /** Shortcut: register a job that returns a single result set of typed entries. */
  setResults(job: string, results: Record<string, string | Uint8Array | number>): void {
    this.setResponse(job, undefined, () => buildResponse(results));
  }

  async init(): Promise<void> {
    /* noop */
  }
  async end(): Promise<void> {
    /* noop */
  }

  async job(
    ecu: string,
    jobName: string,
    params?: string | Uint8Array | (string | Uint8Array)[],
  ): Promise<EdiabasJobResponse> {
    const call: MockCall = { ecu, job: jobName, arg: params };
    this.calls.push(call);
    this.onCall?.(call);
    const list = this.registrations.get(jobName);
    if (!list || list.length === 0) {
      throw new Error(`MockIEdiabas: no registration for job "${jobName}"`);
    }
    // Prefer exact-arg match, then wildcard-arg (arg === undefined).
    // Later registrations shadow earlier ones so tests can override a
    // shared "happy path" helper by re-registering the same job.
    let exact: Registration | undefined;
    let wildcard: Registration | undefined;
    for (const r of list) {
      if (r.arg === undefined) wildcard = r;
      else if (argsEqual(r.arg, params)) exact = r;
    }
    const chosen = exact ?? wildcard;
    if (!chosen) {
      throw new Error(
        `MockIEdiabas: no matching registration for job "${jobName}" with arg ${describeArg(params)}`,
      );
    }
    const resp = typeof chosen.responder === 'function' ? chosen.responder(params) : chosen.responder;
    return resp;
  }

  resultSets(): number {
    return 0;
  }
  resultText(_name: string, _set: number, _format?: string): string {
    return '';
  }
  resultInt(_name: string, _set: number): number {
    return 0;
  }
  resultReal(_name: string, _set: number): number {
    return 0;
  }
  resultBinary(_name: string, _set: number): number[] {
    return [];
  }
  resultFormat(_name: string, _set: number): EdiabasResultType | undefined {
    return undefined;
  }
  state(): EdiabasState {
    return 'ready';
  }
  async break(): Promise<void> {
    /* noop */
  }
  errorCode(): number {
    return 0;
  }
  errorText(): string {
    return '';
  }
}

/**
 * Build a synthetic `EdiabasJobResponse` with a system set (JOB_STATUS,
 * optional VARIANTE etc.) plus one data set carrying the given results.
 * String/number/Uint8Array values are packaged with the right entry type.
 */
export function buildResponse(
  data: Record<string, string | Uint8Array | number>,
  jobStatus: string = 'OKAY',
): EdiabasJobResponse {
  const systemSet: EdiabasResultSet = {
    JOB_STATUS: entry('JOB_STATUS', 'text', jobStatus),
  };
  const dataSet: EdiabasResultSet = {};
  for (const [name, value] of Object.entries(data)) {
    dataSet[name] = toEntry(name, value);
  }
  return { sets: [systemSet, dataSet] };
}

function toEntry(name: string, value: string | Uint8Array | number): EdiabasResultEntry {
  if (typeof value === 'string') return entry(name, 'text', value);
  if (typeof value === 'number') return entry(name, 'long', value);
  return { name, type: 'binary', value: Array.from(value) };
}

function entry(
  name: string,
  type: EdiabasResultType,
  value: string | number | number[],
): EdiabasResultEntry {
  return { name, type, value };
}

function describeArg(arg: MockCall['arg']): string {
  if (arg === undefined) return '<undefined>';
  if (typeof arg === 'string') return JSON.stringify(arg);
  if (arg instanceof Uint8Array) return `Uint8Array(${arg.length})`;
  return `[${arg.map((v) => (typeof v === 'string' ? JSON.stringify(v) : `Uint8Array(${v.length})`)).join(', ')}]`;
}
