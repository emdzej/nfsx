/**
 * Safety surface for flash operations.
 *
 * Wraps callbacks that decide whether a destructive stage may
 * proceed. The default `rejectAllConfirmation` returns `false` for
 * every stage — destructive work requires the caller to supply an
 * explicit `confirm` function that knows the operator approved.
 */

import type { ConfirmContext, RunOptions, Stage } from './types.js';

/**
 * Default `confirm` — returns `false` for every prompt. Forces
 * callers to supply their own.
 */
export const rejectAllConfirmation: NonNullable<RunOptions['confirm']> = () => false;

/**
 * Always returns `true`. **Dangerous** — use only in test
 * harnesses with a mock provider.
 */
export const allowAllConfirmation: NonNullable<RunOptions['confirm']> = () => true;

/**
 * Build a CLI-style confirmation prompt that asks "yes/no" before
 * each stage. Uses readline; lives here only as a convenience, the
 * CLI app composes its own version that respects --yes-to-all etc.
 */
export function buildPromptConfirmation(
  prompt: (question: string) => Promise<string>,
): NonNullable<RunOptions['confirm']> {
  return async (stage: Stage, ctx: ConfirmContext) => {
    const summary = ctx.totalBytes
      ? `${(ctx.totalBytes / 1024).toFixed(1)} KB across ${ctx.regionCount} region(s)`
      : 'no payload metrics';
    const answer = (
      await prompt(
        `\n⚠ About to run stage ${stage} on ECU ${ctx.ecu.sgbd}${ctx.ecu.diagAddr !== undefined ? ` (diag-addr 0x${ctx.ecu.diagAddr.toString(16)})` : ''}\n  ${summary}\n  Proceed? [yes/no] `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === 'yes' || answer === 'y';
  };
}

/**
 * The four stages that actually modify ECU state — `confirm` is
 * consulted before each of these (in non-dry-run mode).
 */
export const DESTRUCTIVE_STAGES: ReadonlySet<Stage> = new Set([
  'AUTHENTICATE',
  'SESSION',
  'TRANSFER',
  'AIF_WRITE',
]);
