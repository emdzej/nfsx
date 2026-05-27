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
 * the PROGRAM stage. Surfaces enough context for the operator to
 * decide knowingly — ECU identity, payload size, the irreversibility
 * notice, and the "no firmware backup" warning.
 *
 * Caller passes a `readline.question`-style async input function.
 * The host CLI may compose its own version that respects `--yes-to-all`,
 * `--no-input`, etc. — this is a baseline.
 *
 * See `docs/first-flash-runbook.md` for the full pre-flash checklist.
 */
export function buildPromptConfirmation(
  prompt: (question: string) => Promise<string>,
): NonNullable<RunOptions['confirm']> {
  return async (stage: Stage, ctx: ConfirmContext) => {
    const lines: string[] = [];
    lines.push('');
    lines.push('  ╔══════════════════════════════════════════════════════════════╗');
    lines.push(`  ║  ⚠  DESTRUCTIVE STAGE: ${stage.padEnd(40)}  ║`);
    lines.push('  ╚══════════════════════════════════════════════════════════════╝');
    lines.push('');
    lines.push(`  ECU SGBD:     ${ctx.ecu.sgbd}`);
    if (ctx.ecu.diagAddr !== undefined) {
      lines.push(`  Diag addr:    0x${ctx.ecu.diagAddr.toString(16).padStart(2, '0')}`);
    }
    if (ctx.ecu.expectedHwnr) {
      lines.push(`  Expected HWNR: ${ctx.ecu.expectedHwnr}`);
    }
    lines.push(`  IPO:          ${ctx.ecu.ipoPath}`);
    if (ctx.ecu.workingDir) {
      lines.push(`  Working dir:  ${ctx.ecu.workingDir}`);
    }
    if (ctx.totalBytes !== undefined) {
      lines.push(
        `  Payload:      ${(ctx.totalBytes / 1024).toFixed(1)} KB across ${ctx.regionCount ?? '?'} region(s)`,
      );
    }
    lines.push('');
    lines.push('  ⚠ This will ERASE and REWRITE the ECU\'s flash memory.');
    lines.push('  ⚠ A failure mid-transfer can BRICK the ECU.');
    lines.push('  ⚠ The "backup" already taken is an AUDIT snapshot — NOT a brick-recovery image.');
    lines.push('  ⚠ Recovery options if this goes wrong: re-flash from SP-Daten (if a matching');
    lines.push('     `.0PA` / `.0DA` exists for the prior ZB) OR replace the ECU.');
    lines.push('');
    const answer = (await prompt('  Type "FLASH" to proceed, anything else to abort: ')).trim();
    return answer === 'FLASH';
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
