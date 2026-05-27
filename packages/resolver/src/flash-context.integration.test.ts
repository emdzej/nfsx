import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveFlashContext, FlashContextError } from './flash-context.js';

/**
 * End-to-end against the real E46_v74 SP-Daten drop.
 * Self-skips when not present.
 *
 * Anchor HWNR: 7544721 (bench GS20 — has 2 ZB candidates, exercises
 * the ambiguity path).
 */

const ROOT = `${process.env.HOME}/Downloads/E46_v74`;
const present = existsSync(`${ROOT}/data/gdaten/HWNR.DA2`);

describe.skipIf(!present)('resolveFlashContext (real E46)', () => {
  it('errors with ambiguous_zb when multiple ZB candidates and no --zb / --zb-alt', () => {
    let err: FlashContextError | undefined;
    try {
      resolveFlashContext(ROOT, '7544721');
    } catch (e) {
      err = e as FlashContextError;
    }
    expect(err).toBeInstanceOf(FlashContextError);
    expect(err?.code).toBe('ambiguous_zb');
    expect(err?.message).toContain('2 ZB candidates');
  });

  it('selects the requested ZB and derives all paths from --hwnr alone', () => {
    const ctx = resolveFlashContext(ROOT, '7544721', { zb: '7552752' });
    expect(ctx.sgTyp).toBe('GD20');
    expect(ctx.sgbd).toBe('10GD20');
    expect(ctx.selectedZb.zbNr).toBe('7552752');
    expect(ctx.ipoPath).toMatch(/sgdat\/10GD20\.IPO$/i);
    expect(ctx.swtIpoPath).toMatch(/sgdat\/00swtds2\.ipo$/i);
    expect(ctx.workingDir).toMatch(/data\/GD20$/);
    expect(ctx.firmwarePath).toMatch(/7544721A\.0PA$/);
    expect(ctx.dataFilePath).toMatch(/A7552753\.0DA$/);
  });

  it('rejects unknown HWNR with a clear code', () => {
    expect(() => resolveFlashContext(ROOT, '9999999')).toThrowError(
      /not in HWNR\.DA2/,
    );
  });
});
