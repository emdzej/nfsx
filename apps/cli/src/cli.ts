#!/usr/bin/env node
/**
 * `nfsx` — the BMW NFS / WinKFP reconstruction CLI.
 *
 * Entrypoint for the `nfsx` bin. Dispatches to subcommands:
 *
 *   nfsx plan --hwnr <HWNR> [--sp-daten <DIR>]
 *     Resolve a part number through the SP-Daten lookup chain and
 *     print the flash context (IPO + SGBD + working files +
 *     transport).
 *
 *   nfsx plan --sg-typ <NAME> [--sp-daten <DIR>]
 *     Resolve by SG short name instead of HWNR.
 *
 *   nfsx plan --diag-addr <HEX> [--sp-daten <DIR>]
 *     Look up by diagnostic address (kmm_SIT.txt).
 *
 * Bare `nfsx` prints the available subcommands.
 *
 * Intentionally minimal — no commander/yargs dependency. The flag
 * surface is tiny enough that a hand-rolled parser is clearer than
 * pulling in a framework.
 */

import { runPlan } from './plan.js';
import { runRun } from './run.js';

function printUsage(): void {
  process.stdout.write(
    `nfsx — BMW NFS / WinKFP reconstruction CLI

Commands:
  plan    Resolve a part number through SP-Daten → IPO + Flash SGBD + auth.
  run     Execute an NFS IPO's cabimain dispatcher and print what it published.

Examples:
  nfsx plan --hwnr 4010581
  nfsx run 16ACC65.ipo --job JOB_ERMITTELN

Per-command help:
  nfsx plan --help
  nfsx run --help
`,
  );
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return 0;
  }

  const cmd = args[0]!;
  switch (cmd) {
    case 'plan':
      return runPlan(args.slice(1));
    case 'run':
      return runRun(args.slice(1));
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      printUsage();
      return 2;
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
