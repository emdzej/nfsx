/**
 * `nfsx browse` — interactive TUI for exploring available updates
 * per HWNR.
 *
 * Pure presentation: resolution lives in `@emdzej/nfsx-resolver`.
 * The TUI just feeds HWNRs (and optional ZB-Alt) into the resolver
 * and renders the result. No business logic.
 *
 * Layout (single-pane v1):
 *
 *   ┌─ HWNR: [_______]   ZB-Alt: [_______]  (tab to switch)
 *   │ Loaded ~/Downloads/E46_v74 (warnings: 0)
 *   │
 *   ├─ Candidate 1/3:  ACC65
 *   │   Compatible HWNRs (3 in family)
 *   │     ▶ 4010581  ← input
 *   │       4010582
 *   │       4010583  (replacement: 4011500)
 *   │   Coding variants (2)
 *   │     ACC65_v01
 *   │     ACC65_v02
 *   │   Transport: KWP2000 via C_ACC65
 *   │   Upgrade for ZB-1703643:
 *   │     → ZB-1744493 (NP-SW 1427105NA)
 *   │
 *   └─ [Tab] switch field   [↑↓] next/prev candidate   [q] quit
 *
 * Keystrokes:
 *   - Tab            switch focus between HWNR and ZB-Alt fields
 *   - typing         edits the focused field
 *   - Backspace      deletes last char of the focused field
 *   - Enter          re-resolve with the current input
 *   - ↑ / ↓          cycle through resolved SG_TYP candidates
 *   - q / Esc        quit
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, render } from 'ink';
import chalk from 'chalk';
import {
  loadSpDatenFromDir,
  resolveByHwnr,
  resolveUpgrade,
  type FlashCandidate,
  type SpDaten,
} from '@emdzej/nfsx-resolver';
import type { NpvRow } from '@emdzej/nfsx-data-files';
import type { BrowseOptions } from './cli.js';

export function runBrowse(opts: BrowseOptions): Promise<number> {
  // Load SP-Daten synchronously up front. If the path is bad, fail
  // before mounting the TUI — saves the user from staring at an
  // empty screen.
  let spDaten: SpDaten;
  try {
    spDaten = loadSpDatenFromDir(opts.spDaten);
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `error: could not load SP-Daten from ${opts.spDaten}: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return Promise.resolve(2);
  }

  return new Promise((resolve) => {
    const instance = render(
      <BrowseApp
        spDaten={spDaten}
        initialHwnr={opts.hwnr ?? ''}
        initialZbAlt={opts.zbAlt ?? ''}
        spDatenPath={opts.spDaten}
        onExit={() => {
          instance.unmount();
          resolve(0);
        }}
      />,
    );
  });
}

type Field = 'hwnr' | 'zbAlt';

interface BrowseAppProps {
  spDaten: SpDaten;
  spDatenPath: string;
  initialHwnr: string;
  initialZbAlt: string;
  onExit: () => void;
}

function BrowseApp({
  spDaten,
  spDatenPath,
  initialHwnr,
  initialZbAlt,
  onExit,
}: BrowseAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [hwnr, setHwnr] = useState(initialHwnr);
  const [zbAlt, setZbAlt] = useState(initialZbAlt);
  const [field, setField] = useState<Field>('hwnr');
  const [candidateIdx, setCandidateIdx] = useState(0);
  const [submittedHwnr, setSubmittedHwnr] = useState(initialHwnr);
  const [submittedZbAlt, setSubmittedZbAlt] = useState(initialZbAlt);

  // Resolve only on submit (Enter), not on every keystroke — the
  // resolver scans the full SP-Daten on each call, so debouncing via
  // explicit Enter keeps the UI snappy and avoids partial-input
  // lookups (`401` would resolve to nothing then `4010581` would
  // resolve correctly — confusing as you type).
  const candidates = useMemo<FlashCandidate[]>(() => {
    if (!submittedHwnr) return [];
    return resolveByHwnr(spDaten, submittedHwnr);
  }, [spDaten, submittedHwnr]);

  const upgrade = useMemo<NpvRow | undefined>(() => {
    if (!submittedZbAlt) return undefined;
    return resolveUpgrade(spDaten, submittedZbAlt);
  }, [spDaten, submittedZbAlt]);

  // Snap the candidate cursor back into range whenever the candidate
  // list changes — typing a new HWNR can leave it pointing past the
  // end of a shorter list.
  useEffect(() => {
    if (candidateIdx >= candidates.length && candidates.length > 0) {
      setCandidateIdx(0);
    }
  }, [candidates.length, candidateIdx]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      exit();
      onExit();
      return;
    }
    if (key.tab) {
      setField((f) => (f === 'hwnr' ? 'zbAlt' : 'hwnr'));
      return;
    }
    if (key.return) {
      setSubmittedHwnr(hwnr);
      setSubmittedZbAlt(zbAlt);
      setCandidateIdx(0);
      return;
    }
    if (key.upArrow) {
      if (candidates.length > 0) setCandidateIdx((i) => (i === 0 ? candidates.length - 1 : i - 1));
      return;
    }
    if (key.downArrow) {
      if (candidates.length > 0) setCandidateIdx((i) => (i + 1) % candidates.length);
      return;
    }
    if (key.backspace || key.delete) {
      if (field === 'hwnr') setHwnr((s) => s.slice(0, -1));
      else setZbAlt((s) => s.slice(0, -1));
      return;
    }
    // Plain printable input — append. Allow only alnum + a few
    // BMW-style separators (hyphens in ZB-numbers etc).
    if (input && /^[A-Za-z0-9-]+$/.test(input)) {
      if (field === 'hwnr') setHwnr((s) => s + input);
      else setZbAlt((s) => s + input);
    }
  });

  const current = candidates[candidateIdx];

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          nfsx browse
        </Text>
        <Text dimColor> — available updates per HWNR</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <InputRow label="HWNR" value={hwnr} focused={field === 'hwnr'} />
        <InputRow label="ZB-Alt" value={zbAlt} focused={field === 'zbAlt'} />
        <Box>
          <Text dimColor>SP-Daten: </Text>
          <Text>{spDatenPath}</Text>
          {spDaten.warnings.length > 0 && (
            <Text color="yellow"> ({spDaten.warnings.length} warning{spDaten.warnings.length === 1 ? '' : 's'})</Text>
          )}
        </Box>
      </Box>

      {submittedHwnr === '' ? (
        <Text dimColor>Enter a HWNR above and press Enter to resolve.</Text>
      ) : candidates.length === 0 ? (
        <Text color="yellow">no SG_TYP found for HWNR "{submittedHwnr}"</Text>
      ) : (
        <CandidateView
          candidate={current!}
          candidateIdx={candidateIdx}
          totalCandidates={candidates.length}
          submittedHwnr={submittedHwnr}
          upgrade={upgrade}
          submittedZbAlt={submittedZbAlt}
        />
      )}

      <Box marginTop={1}>
        <Text dimColor>
          [Tab] switch field   [Enter] resolve   [↑↓] next/prev SG_TYP   [q/Esc] quit
        </Text>
      </Box>
    </Box>
  );
}

function InputRow({
  label,
  value,
  focused,
}: {
  label: string;
  value: string;
  focused: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Text dimColor>{label.padEnd(7)}: </Text>
      <Text color={focused ? 'cyan' : undefined} inverse={focused && value.length === 0}>
        {value || (focused ? ' ' : '—')}
      </Text>
      {focused && value.length > 0 && <Text color="cyan">▌</Text>}
    </Box>
  );
}

function CandidateView({
  candidate,
  candidateIdx,
  totalCandidates,
  submittedHwnr,
  upgrade,
  submittedZbAlt,
}: {
  candidate: FlashCandidate;
  candidateIdx: number;
  totalCandidates: number;
  submittedHwnr: string;
  upgrade: NpvRow | undefined;
  submittedZbAlt: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="green">
          [{candidateIdx + 1}/{totalCandidates}] SG_TYP: {candidate.sgTyp}
        </Text>
      </Box>

      <Section title={`Compatible HWNRs (${candidate.hwnrRows.length})`}>
        {candidate.hwnrRows.map((row) => {
          const isInput = row.hwnr === submittedHwnr;
          return (
            <Box key={row.hwnr + ':' + row.lineNo}>
              <Text color={isInput ? 'cyan' : undefined}>{isInput ? '▶ ' : '  '}{row.hwnr}</Text>
              {row.atHwnr !== '0000000' && (
                <Text dimColor>  (replacement: {row.atHwnr})</Text>
              )}
              {row.epTsnr !== '0000000' && (
                <Text dimColor>  [ET: {row.epTsnr}]</Text>
              )}
            </Box>
          );
        })}
      </Section>

      {candidate.kfConfRows.length > 0 && (
        <Section title={`Coding variants (${candidate.kfConfRows.length})`}>
          {candidate.kfConfRows.map((row, i) => (
            <Box key={i}>
              <Text>  variant 0x{row.variantHex}</Text>
              <Text dimColor>  v{row.version}</Text>
              <Text dimColor>  IPO {row.ipoFile}</Text>
              <Text dimColor>  SGBD {row.flashSgbd}</Text>
            </Box>
          ))}
        </Section>
      )}

      <Section title="Transport">
        {candidate.prgIfSel ? (
          <Box>
            <Text>  {candidate.prgIfSel.protocol}</Text>
            <Text dimColor>  (via {candidate.prgIfSel.sgName})</Text>
          </Box>
        ) : (
          <Text dimColor>  no prgifsel row</Text>
        )}
        {candidate.sit && (
          <Box flexDirection="column">
            <Box>
              <Text dimColor>  diag-addr </Text>
              <Text>0x{candidate.sit.diagAddr.toString(16).toUpperCase().padStart(2, '0')}</Text>
              <Text dimColor>  short </Text>
              <Text>{candidate.sit.shortName}</Text>
            </Box>
          </Box>
        )}
      </Section>

      {submittedZbAlt !== '' && (
        <Section title={`Upgrade for ZB-${submittedZbAlt}`}>
          {upgrade ? (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>  → </Text>
                <Text bold color="green">ZB-{upgrade.zbNeu}</Text>
                <Text dimColor>  via NP-SW </Text>
                <Text>{upgrade.npSw}</Text>
              </Box>
              <Box>
                <Text dimColor>  flash mask </Text>
                <Text>{upgrade.am}</Text>
              </Box>
            </Box>
          ) : (
            <Text color="yellow">  no NPV upgrade for this ZB-Alt</Text>
          )}
        </Section>
      )}
    </Box>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">{title}</Text>
      {children}
    </Box>
  );
}
