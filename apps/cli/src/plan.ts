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

import {
  loadSpDatenFromDir,
  loadZbNrTabForSg,
  resolveByHwnr,
  resolveBySgTyp,
  resolveByDiagAddr,
  resolveUpgrade,
  type FlashCandidate,
  type SpDaten,
} from '@emdzej/nfsx-resolver/node';
import { findByHwNr, type NpvRow, type ZbNrTabRow } from '@emdzej/nfsx-data-files';
import chalk from 'chalk';
import type { PlanOptions } from './cli.js';
import { resolveSpDaten, NfsxConfigError } from './config.js';

interface ResolvedPlanOptions extends PlanOptions {
  /** Effective SP-Daten path after merging --sp-daten, --config, env. */
  spDatenResolved: string;
}

type PlanFlags = ResolvedPlanOptions;

export function runPlan(opts: PlanOptions): number {
  if (!opts.hwnr && !opts.sgTyp && opts.diagAddr === undefined) {
    process.stderr.write(
      chalk.red('error: one of --hwnr / --sg-typ / --diag-addr is required (see `nfsx plan --help`)\n'),
    );
    return 2;
  }

  let spDatenResolved: string;
  try {
    spDatenResolved = resolveSpDaten({ spDaten: opts.spDaten, configPath: opts.config });
  } catch (err) {
    process.stderr.write(
      chalk.red(`error: ${err instanceof NfsxConfigError ? err.message : String(err)}\n`),
    );
    return 2;
  }

  const resolvedOpts: ResolvedPlanOptions = { ...opts, spDatenResolved };
  const sp = loadSpDatenFromDir(spDatenResolved);

  if (sp.warnings.length > 0) {
    for (const w of sp.warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }
  }

  if (opts.json) {
    return emitJson(sp, resolvedOpts);
  }
  return emitText(sp, resolvedOpts);
}

function emitText(sp: SpDaten, flags: PlanFlags): number {
  const candidates = resolve(sp, flags);
  const upgrade = flags.zbAlt ? resolveUpgrade(sp, flags.zbAlt) : undefined;

  if (candidates.length === 0 && !upgrade) {
    process.stderr.write(`No candidates found for ${describeLookup(flags)}.\n`);
    return 1;
  }

  process.stdout.write(`\nLookup: ${describeLookup(flags)}\n`);
  process.stdout.write(`SP-Daten: ${flags.spDatenResolved}\n`);
  if (candidates.length > 0) {
    process.stdout.write(`Candidates: ${candidates.length}\n\n`);
    for (let i = 0; i < candidates.length; i++) {
      printCandidate(candidates[i]!, i + 1, candidates.length, flags);
    }
  }
  if (flags.zbAlt) {
    printUpgrade(flags.zbAlt, upgrade);
  }

  return 0;
}

function emitJson(sp: SpDaten, flags: PlanFlags): number {
  const candidates = resolve(sp, flags);
  const upgrade = flags.zbAlt ? resolveUpgrade(sp, flags.zbAlt) : undefined;
  process.stdout.write(
    JSON.stringify(
      {
        lookup: describeLookup(flags),
        spDaten: flags.spDatenResolved,
        warnings: sp.warnings,
        candidates,
        zbAlt: flags.zbAlt ?? null,
        upgrade: upgrade ?? null,
      },
      null,
      2,
    ) + '\n',
  );
  return candidates.length === 0 && !upgrade ? 1 : 0;
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

function printCandidate(c: FlashCandidate, idx: number, total: number, flags: PlanFlags): void {
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

      // Flash-file candidates: load the per-SG ZB-NR table named by
      // KFCONF and surface rows matching the queried HWNR.
      if (c.hwnr && k.datFile) {
        const tab = loadZbNrTabForSg(flags.spDatenResolved, c.sgTyp, k.datFile);
        if (!tab) {
          process.stdout.write(`      Flash files: (no ${k.datFile} on disk under data/${c.sgTyp}/)\n`);
        } else {
          const rows = findByHwNr(tab, c.hwnr);
          if (rows.length === 0) {
            process.stdout.write(`      Flash files: (HWNR ${c.hwnr} not in ${k.datFile})\n`);
          } else {
            process.stdout.write(`      Flash files (${rows.length} ZB rows):\n`);
            for (const r of rows) printZbNrRow(r);
          }
        }
      }
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

  if (c.prgIfSel) {
    process.stdout.write(`  prgifsel row:\n`);
    process.stdout.write(`      Protocol:   ${c.prgIfSel.protocol}\n`);
    process.stdout.write(`      Interface:  ${c.prgIfSel.iface}\n`);
    process.stdout.write(`      Hardware:   ${c.prgIfSel.hardware}\n`);
    process.stdout.write(`      Info:       ${c.prgIfSel.information}\n`);
  } else {
    process.stdout.write(`  prgifsel row:   (none — no transport selector for this SG)\n`);
  }

  const totalAuth = c.sgIdc.length + c.sgIdd.length;
  if (totalAuth > 0) {
    process.stdout.write(`  Auth material:  ${c.sgIdc.length} SGIDC + ${c.sgIdd.length} SGIDD entries\n`);
    for (const e of c.sgIdc) {
      process.stdout.write(`      SGIDC (L3): ${truncatePayload(e.payload)}\n`);
    }
    for (const e of c.sgIdd) {
      process.stdout.write(`      SGIDD (L4): ${truncatePayload(e.payload)}\n`);
    }
  } else {
    process.stdout.write(`  Auth material:  (none — no SGIDC/SGIDD entries for this SG)\n`);
  }
  process.stdout.write(`\n`);
}

function truncatePayload(p: string): string {
  if (p.length <= 60) return p;
  return `${p.slice(0, 40)}…(${p.length} chars total)`;
}

function printZbNrRow(r: ZbNrTabRow): void {
  // One line per ZB row — the canonical "what you'd flash for this ZB":
  //   ZB=7552752 (IX=A): 7544721A.0PA + A7552753.0DA  PIN=134 S=1 CS=G
  const data = r.dataFile ?? '(no .0DA — SW-NR has no DA suffix)';
  process.stdout.write(
    `        ZB=${r.zbNr}: ${r.programFile} + ${data}` +
      `  PIN=${r.pin} S=${r.s} CS=${r.csRaw}\n`,
  );
}

function printUpgrade(zbAlt: string, upgrade: NpvRow | undefined): void {
  process.stdout.write(`Upgrade lookup (ZB-ALT=${zbAlt})\n`);
  process.stdout.write(`${'─'.repeat(40)}\n`);
  if (!upgrade) {
    process.stdout.write(`  (no upgrade rule in npv.dat for this ZB)\n\n`);
    return;
  }
  process.stdout.write(`  ZB-NEU:     ${upgrade.zbNeu}\n`);
  process.stdout.write(`  NP-SW:      ${upgrade.npSw}\n`);
  process.stdout.write(`  AM (mask):  ${upgrade.am}\n`);
  process.stdout.write(`  S (status): ${upgrade.s ?? '(unset)'}\n`);
  process.stdout.write(`  M:          ${upgrade.m ?? '(unset)'}\n`);
  process.stdout.write(`  CS:         ${upgrade.cs}\n\n`);
}

