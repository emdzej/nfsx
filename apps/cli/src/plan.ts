/**
 * `nfsx plan` — resolve a part number / SG_TYP / DiagAddr through
 * the SP-Daten lookup chain and print the flash context.
 *
 * Demonstrates the v0.1.0 milestone end-to-end: given just an HWNR
 * (or SG name or DiagAddr) and a path to an SP-Daten drop, we can
 * tell the user which IPO would run, which SGBD would handle the
 * wire, and (when SIT covers the ECU) what transport / flash-limit
 * applies.
 *
 * No actual flash dispatch — that's Phase 3+. This is the
 * read-only resolver demo.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadSpDatenFromDir,
  resolveByHwnr,
  resolveBySgTyp,
  resolveByDiagAddr,
  type FlashCandidate,
  type SpDaten,
} from '@emdzej/nfsx-resolver';

interface PlanFlags {
  hwnr?: string;
  sgTyp?: string;
  diagAddr?: number;
  spDaten: string;
  json: boolean;
  help: boolean;
}

const HELP = `nfsx plan — resolve a BMW ECU through the SP-Daten lookup chain.

Usage:
  nfsx plan --hwnr <HWNR>      [--sp-daten <DIR>] [--json]
  nfsx plan --sg-typ <NAME>    [--sp-daten <DIR>] [--json]
  nfsx plan --diag-addr <HEX>  [--sp-daten <DIR>] [--json]

Inputs (one of):
  --hwnr <HWNR>        BMW part number (e.g. 4010581) — looks up via
                       HWNR.DA2 → KFCONF10.DA2 → kmm_SIT.txt.
  --sg-typ <NAME>      SG short name (e.g. ACC65) — looks up via
                       KFCONF10.DA2 directly.
  --diag-addr <HEX>    Diagnostic address (e.g. 0x12 or 12) — looks
                       up via kmm_SIT.txt.

Options:
  --sp-daten <DIR>     Path to SP-Daten chassis drop.
                       Default: $NFSX_SP_DATEN or ~/Downloads/E46_v74
  --json               Emit JSON instead of pretty text.
  --help               Show this help.
`;

export function runPlan(args: string[]): number {
  const flags = parseFlags(args);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!flags.hwnr && !flags.sgTyp && flags.diagAddr === undefined) {
    process.stderr.write('error: one of --hwnr / --sg-typ / --diag-addr is required\n\n');
    process.stderr.write(HELP);
    return 2;
  }

  const sp = loadSpDatenFromDir(flags.spDaten);

  if (sp.warnings.length > 0) {
    for (const w of sp.warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }
  }

  if (flags.json) {
    return emitJson(sp, flags);
  }
  return emitText(sp, flags);
}

function emitText(sp: SpDaten, flags: PlanFlags): number {
  const candidates = resolve(sp, flags);

  if (candidates.length === 0) {
    process.stderr.write(`No candidates found for ${describeLookup(flags)}.\n`);
    return 1;
  }

  process.stdout.write(`\nLookup: ${describeLookup(flags)}\n`);
  process.stdout.write(`SP-Daten: ${flags.spDaten}\n`);
  process.stdout.write(`Candidates: ${candidates.length}\n\n`);

  for (let i = 0; i < candidates.length; i++) {
    printCandidate(candidates[i]!, i + 1, candidates.length);
  }

  return 0;
}

function emitJson(sp: SpDaten, flags: PlanFlags): number {
  const candidates = resolve(sp, flags);
  process.stdout.write(
    JSON.stringify(
      {
        lookup: describeLookup(flags),
        spDaten: flags.spDaten,
        warnings: sp.warnings,
        candidates,
      },
      null,
      2,
    ) + '\n',
  );
  return candidates.length === 0 ? 1 : 0;
}

function resolve(sp: SpDaten, flags: PlanFlags): FlashCandidate[] {
  if (flags.hwnr) return resolveByHwnr(sp, flags.hwnr);
  if (flags.sgTyp) {
    const c = resolveBySgTyp(sp, flags.sgTyp);
    return c ? [c] : [];
  }
  if (flags.diagAddr !== undefined) return resolveByDiagAddr(sp, flags.diagAddr);
  return [];
}

function describeLookup(flags: PlanFlags): string {
  if (flags.hwnr) return `HWNR=${flags.hwnr}`;
  if (flags.sgTyp) return `SG_TYP=${flags.sgTyp}`;
  if (flags.diagAddr !== undefined) return `DiagAddr=0x${flags.diagAddr.toString(16)}`;
  return '(no input)';
}

function printCandidate(c: FlashCandidate, idx: number, total: number): void {
  const header = total > 1 ? `Candidate ${idx}/${total}: SG_TYP=${c.sgTyp}` : `SG_TYP: ${c.sgTyp}`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${'─'.repeat(header.length)}\n`);

  if (c.hwnr) {
    process.stdout.write(`  Queried HWNR:   ${c.hwnr}\n`);
  }
  if (c.hwnrRows.length > 0) {
    process.stdout.write(`  Known HWNRs:    ${c.hwnrRows.length} (e.g. ${c.hwnrRows[0]!.hwnr}${c.hwnrRows.length > 1 ? ', …' : ''})\n`);
  }

  if (c.kfConfRows.length === 0) {
    process.stdout.write(`  KFCONF:         (none — SG_TYP isn't flashable in this drop)\n`);
  } else {
    process.stdout.write(`  KFCONF rows:    ${c.kfConfRows.length}\n`);
    for (const k of c.kfConfRows) {
      process.stdout.write(`    variant ${k.variantHex}/${k.version}:\n`);
      process.stdout.write(`      IPO:        ${k.ipoFile}\n`);
      process.stdout.write(`      Flash SGBD: ${k.flashSgbd}\n`);
      process.stdout.write(`      Working:    .HIS=${k.hisFile}  .DAT=${k.datFile}  .DIR=${k.dirFile}  .HWH=${k.hwhFile}\n`);
    }
  }

  if (c.sit) {
    process.stdout.write(`  kmm_SIT row:\n`);
    process.stdout.write(`      DiagAddr:   0x${c.sit.diagAddr.toString(16).padStart(2, '0')}\n`);
    process.stdout.write(`      Transport:  ${c.sit.transport}\n`);
    process.stdout.write(`      Flash limit:${c.sit.flashLimit ?? '(unset)'}\n`);
    process.stdout.write(`      Category:   ${c.sit.category}\n`);
    process.stdout.write(`      AIF mode:   ${c.sit.aifMode}\n`);
    process.stdout.write(`      HW-ID mode: ${c.sit.hwIdMode}\n`);
  } else {
    process.stdout.write(`  kmm_SIT row:    (none — SP-Daten SIT doesn't cover this SG)\n`);
  }
  process.stdout.write(`\n`);
}

function parseFlags(args: string[]): PlanFlags {
  const defaultDir =
    process.env.NFSX_SP_DATEN ?? join(homedir(), 'Downloads', 'E46_v74');
  const flags: PlanFlags = { spDaten: defaultDir, json: false, help: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--hwnr':
        flags.hwnr = takeValue(args, i);
        i++;
        break;
      case '--sg-typ':
        flags.sgTyp = takeValue(args, i);
        i++;
        break;
      case '--diag-addr': {
        const v = takeValue(args, i);
        i++;
        const parsed = v.toLowerCase().startsWith('0x')
          ? Number.parseInt(v.slice(2), 16)
          : Number.parseInt(v, 16); // default to hex like the file format
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) {
          process.stderr.write(`error: --diag-addr "${v}" is not a valid hex byte\n`);
          process.exit(2);
        }
        flags.diagAddr = parsed;
        break;
      }
      case '--sp-daten':
        flags.spDaten = takeValue(args, i);
        i++;
        break;
      default:
        process.stderr.write(`error: unknown flag "${a}"\n\n`);
        process.stderr.write(HELP);
        process.exit(2);
    }
  }

  return flags;
}

/** Read the value at `args[idx + 1]`; bail if missing or another flag. */
function takeValue(args: string[], idx: number): string {
  const v = args[idx + 1];
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`error: ${args[idx]} requires a value\n`);
    process.exit(2);
  }
  return v;
}
