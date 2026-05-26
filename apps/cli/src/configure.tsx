/**
 * `nfsx configure` — small ink form for editing the persistent
 * config at `~/.config/nfsx/config.json` (or `--output <path>`).
 *
 * v1 fields: just `spDaten`. Schema is open-ended; new fields land
 * here as they become relevant. Keep this lean — the ediabasx
 * configure TUI has a more elaborate wizard; we don't need it yet.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, render } from 'ink';
import chalk from 'chalk';
import {
  loadConfigSoft,
  saveConfig,
  suggestSpDaten,
  DEFAULT_CONFIG_PATH,
  type NfsxConfig,
} from './config.js';

export interface ConfigureOptions {
  output: string;
}

export function runConfigure(opts: ConfigureOptions): Promise<number> {
  const initial = loadConfigSoft(opts.output);
  // Pre-fill the form with the best guess — existing config wins,
  // then NFSX_SP_DATEN, then the developer-known default. First-run
  // is a single Enter to accept.
  const seeded: NfsxConfig = { spDaten: suggestSpDaten(initial) };
  return new Promise((resolveDone) => {
    const instance = render(
      <ConfigureApp
        initial={seeded}
        outputPath={opts.output}
        existedBefore={initial.spDaten !== undefined}
        onSave={(cfg) => {
          saveConfig(cfg, opts.output);
          process.stdout.write(chalk.green(`\n✓ saved ${opts.output}\n`));
          instance.unmount();
          resolveDone(0);
        }}
        onCancel={() => {
          instance.unmount();
          resolveDone(0);
        }}
      />,
    );
  });
}

interface ConfigureAppProps {
  initial: NfsxConfig;
  outputPath: string;
  existedBefore: boolean;
  onSave: (cfg: NfsxConfig) => void;
  onCancel: () => void;
}

function ConfigureApp({ initial, outputPath, existedBefore, onSave, onCancel }: ConfigureAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [spDaten, setSpDaten] = useState(initial.spDaten ?? '');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      exit();
      return;
    }
    if (key.return) {
      onSave({ spDaten: spDaten.trim() === '' ? undefined : spDaten.trim() });
      exit();
      return;
    }
    if (key.backspace || key.delete) {
      setSpDaten((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setSpDaten((s) => s + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">nfsx configure</Text>
        <Text dimColor>  {existedBefore ? 'editing' : 'creating'} </Text>
        <Text>{outputPath}</Text>
        {outputPath === DEFAULT_CONFIG_PATH && <Text dimColor>  (default)</Text>}
        {!existedBefore && <Text color="yellow">  (pre-filled — Enter to accept)</Text>}
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>SP-Daten: </Text>
        <Text color="cyan">{spDaten || ' '}</Text>
        <Text color="cyan">▌</Text>
      </Box>

      <Box>
        <Text dimColor>
          Type to edit, [Backspace] to delete, [Enter] to save, [Esc] to cancel.
        </Text>
      </Box>
    </Box>
  );
}
