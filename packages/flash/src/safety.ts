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
 * The one stage that actually modifies ECU state — `confirm` is
 * consulted before this in non-dry-run mode. (Pre-2026-05-27 the
 * pipeline had four destructive stages: AUTHENTICATE / SESSION /
 * TRANSFER / AIF_WRITE. The rewrite collapsed them into a single
 * SG_PROGRAMMIEREN IPO dispatch — see types.ts and prog-sg.ts.)
 */
export const DESTRUCTIVE_STAGES: ReadonlySet<Stage> = new Set(['PROGRAM']);
