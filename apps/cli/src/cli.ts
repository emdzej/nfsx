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

function printUsage(): void {
  process.stdout.write(
    `nfsx — BMW NFS / WinKFP reconstruction CLI

Usage:
  nfsx plan --hwnr <HWNR>      [--sp-daten <DIR>]
  nfsx plan --sg-typ <NAME>    [--sp-daten <DIR>]
  nfsx plan --diag-addr <HEX>  [--sp-daten <DIR>]

Options:
  --sp-daten <DIR>   Path to an extracted SP-Daten chassis drop.
                     Default: $NFSX_SP_DATEN or ~/Downloads/E46_v74
  --json             Emit machine-readable JSON instead of pretty text.
  --help             Show this help.

Examples:
  nfsx plan --hwnr 4010581
  nfsx plan --sg-typ ACC65 --sp-daten ~/Downloads/E60_v75
  nfsx plan --diag-addr 0x12 --json
`,
  );
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return 0;
  }

  const cmd = args[0]!;
  switch (cmd) {
    case 'plan':
      return runPlan(args.slice(1));
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      printUsage();
      return 2;
  }
}

process.exit(main(process.argv));
