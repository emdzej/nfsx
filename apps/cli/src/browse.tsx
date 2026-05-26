/**
 * `nfsx browse` — full-screen multi-panel TUI for exploring HWNRs
 * in a loaded SP-Daten drop.
 *
 * Layout (3 columns + a header / footer):
 *
 *   ┌─ nfsx browse ────────────────────────────  HWNRs: 1234   SP-Daten: …  ─┐
 *   │ HWNRs                       │ SG_TYP: ACC65                            │
 *   │ filter: [acc____]           │   Compatible HWNRs (8)                   │
 *   │ ▸ 4010581                   │     ▶ 4010581   ← selected               │
 *   │   4011919                   │       4011919                            │
 *   │   4015295                   │       …                                  │
 *   │   …                         │   Coding variants (1) …                  │
 *   │                             │   Transport (KWP2000* via …)             │
 *   │                             │   Upgrade for ZB-1703643 → ZB-1744493    │
 *   └─ [↑↓] HWNR  [/] filter  [tab] HWNR/ZB-Alt  [Enter] resolve  [q] quit  ─┘
 *
 * Pure presentation — resolution lives in `@emdzej/nfsx-resolver`;
 * the TUI just renders results.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout, render } from 'ink';
import chalk from 'chalk';
import {
  loadSpDatenFromDir,
  resolveByHwnr,
  resolveUpgrade,
  type FlashCandidate,
  type SpDaten,
} from '@emdzej/nfsx-resolver';
import type { HwnrRow, NpvRow } from '@emdzej/nfsx-data-files';
import type { BrowseOptions } from './cli.js';
import { resolveSpDaten, NfsxConfigError } from './config.js';

export function runBrowse(opts: BrowseOptions): Promise<number> {
  let spDatenPath: string;
  try {
    spDatenPath = resolveSpDaten({ spDaten: opts.spDaten, configPath: opts.config });
  } catch (err) {
    process.stderr.write(
      chalk.red(`error: ${err instanceof NfsxConfigError ? err.message : String(err)}\n`),
    );
    return Promise.resolve(2);
  }

  let spDaten: SpDaten;
  try {
    spDaten = loadSpDatenFromDir(spDatenPath);
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `error: could not load SP-Daten from ${spDatenPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return Promise.resolve(2);
  }

  return new Promise((resolveDone) => {
    const instance = render(
      <BrowseApp
        spDaten={spDaten}
        spDatenPath={spDatenPath}
        initialHwnr={opts.hwnr ?? ''}
        initialZbAlt={opts.zbAlt ?? ''}
        onExit={() => {
          instance.unmount();
          resolveDone(0);
        }}
      />,
    );
  });
}

type Focus = 'list' | 'filter' | 'zbAlt';

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
  const [cols, rows] = useStdoutDimensions();

  // Stable, deduplicated HWNR list — `spDaten.hwnr.rows` may have
  // duplicate `hwnr` values across multiple `sgTyp` rows; we want
  // each HWNR listed once. Order is HWNR.DA2 file order, which is
  // already roughly sorted in real drops.
  const allHwnrs = useMemo<HwnrRow[]>(() => {
    if (!spDaten.hwnr) return [];
    const seen = new Set<string>();
    const out: HwnrRow[] = [];
    for (const row of spDaten.hwnr.rows) {
      if (seen.has(row.hwnr)) continue;
      seen.add(row.hwnr);
      out.push(row);
    }
    return out;
  }, [spDaten]);

  const [filter, setFilter] = useState(initialHwnr);
  const [zbAlt, setZbAlt] = useState(initialZbAlt);
  const [focus, setFocus] = useState<Focus>(initialHwnr ? 'list' : 'filter');
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Filter the HWNR list by prefix substring (case-insensitive) +
  // SG_TYP substring. Empty filter = full list.
  const filteredHwnrs = useMemo<HwnrRow[]>(() => {
    if (filter.trim() === '') return allHwnrs;
    const needle = filter.trim().toLowerCase();
    return allHwnrs.filter(
      (row) => row.hwnr.toLowerCase().includes(needle) || row.sgTyp.toLowerCase().includes(needle),
    );
  }, [allHwnrs, filter]);

  // Snap selection into range when the filter changes.
  useEffect(() => {
    if (selectedIdx >= filteredHwnrs.length) {
      setSelectedIdx(Math.max(0, filteredHwnrs.length - 1));
    }
  }, [filteredHwnrs.length, selectedIdx]);

  const selectedRow = filteredHwnrs[selectedIdx];

  // Resolve the selected HWNR through the full lookup chain whenever
  // the selection changes.
  const candidates = useMemo<FlashCandidate[]>(() => {
    if (!selectedRow) return [];
    return resolveByHwnr(spDaten, selectedRow.hwnr);
  }, [spDaten, selectedRow]);

  const upgrade = useMemo<NpvRow | undefined>(() => {
    if (!zbAlt.trim()) return undefined;
    return resolveUpgrade(spDaten, zbAlt.trim());
  }, [spDaten, zbAlt]);

  useInput((input, key) => {
    if (key.escape || (input === 'q' && focus === 'list')) {
      exit();
      onExit();
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === 'list' ? 'filter' : f === 'filter' ? 'zbAlt' : 'list'));
      return;
    }
    // List navigation
    if (focus === 'list') {
      if (key.upArrow) {
        setSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((i) => Math.min(filteredHwnrs.length - 1, i + 1));
        return;
      }
      if (key.pageUp) {
        setSelectedIdx((i) => Math.max(0, i - 10));
        return;
      }
      if (key.pageDown) {
        setSelectedIdx((i) => Math.min(filteredHwnrs.length - 1, i + 10));
        return;
      }
      if (input === '/') {
        setFocus('filter');
        return;
      }
      return;
    }
    // Filter / ZB-Alt editing
    if (key.return) {
      setFocus('list');
      return;
    }
    if (key.backspace || key.delete) {
      if (focus === 'filter') setFilter((s) => s.slice(0, -1));
      else setZbAlt((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta && /^[A-Za-z0-9-]$/.test(input)) {
      if (focus === 'filter') setFilter((s) => s + input);
      else setZbAlt((s) => s + input);
    }
  });

  // Layout maths — full-screen, two columns. Reserve 2 rows for
  // header, 2 rows for footer.
  const innerHeight = Math.max(8, rows - 4);
  const leftWidth = Math.max(24, Math.floor(cols * 0.35));
  const rightWidth = Math.max(40, cols - leftWidth - 1);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header
        spDatenPath={spDatenPath}
        warnings={spDaten.warnings.length}
        hwnrTotal={allHwnrs.length}
        filteredTotal={filteredHwnrs.length}
        cols={cols}
      />

      <Box flexDirection="row" height={innerHeight}>
        <HwnrListPanel
          rows={filteredHwnrs}
          selectedIdx={selectedIdx}
          filter={filter}
          focused={focus === 'list' || focus === 'filter'}
          filterFocused={focus === 'filter'}
          width={leftWidth}
          height={innerHeight}
        />
        <DetailsPanel
          row={selectedRow}
          candidates={candidates}
          zbAlt={zbAlt}
          zbAltFocused={focus === 'zbAlt'}
          upgrade={upgrade}
          width={rightWidth}
          height={innerHeight}
        />
      </Box>

      <Footer focus={focus} cols={cols} />
    </Box>
  );
}

// ── header / footer ─────────────────────────────────────────────────

function Header({
  spDatenPath,
  warnings,
  hwnrTotal,
  filteredTotal,
  cols,
}: {
  spDatenPath: string;
  warnings: number;
  hwnrTotal: number;
  filteredTotal: number;
  cols: number;
}): React.JSX.Element {
  const left = ` nfsx browse `;
  const right = ` HWNRs: ${filteredTotal}/${hwnrTotal}   SP-Daten: ${truncatePath(spDatenPath, Math.max(20, cols - left.length - 30))}${warnings > 0 ? `  (${warnings} warning${warnings === 1 ? '' : 's'})` : ''} `;
  const fill = Math.max(1, cols - left.length - right.length);
  return (
    <Box>
      <Text bold color="cyan" inverse>
        {left}
      </Text>
      <Text dimColor>{'─'.repeat(fill)}</Text>
      <Text dimColor>{right}</Text>
    </Box>
  );
}

function Footer({ focus, cols }: { focus: Focus; cols: number }): React.JSX.Element {
  const hints =
    focus === 'list'
      ? '[↑↓ PgUp/PgDn] navigate  [/] filter  [Tab] focus  [q] quit'
      : focus === 'filter'
        ? '[type] filter  [Enter] back to list  [Tab] ZB-Alt  [Esc] quit'
        : '[type] ZB-Alt  [Enter] back to list  [Tab] HWNR filter  [Esc] quit';
  return (
    <Box>
      <Text dimColor>{'─'.repeat(cols)}</Text>
      <Box position="absolute" marginLeft={2}>
        <Text dimColor> {hints} </Text>
      </Box>
    </Box>
  );
}

// ── left panel: HWNR list ───────────────────────────────────────────

function HwnrListPanel({
  rows,
  selectedIdx,
  filter,
  focused,
  filterFocused,
  width,
  height,
}: {
  rows: HwnrRow[];
  selectedIdx: number;
  filter: string;
  focused: boolean;
  filterFocused: boolean;
  width: number;
  height: number;
}): React.JSX.Element {
  // Inside-the-panel layout: 1 row for filter, rest for list (scrolling).
  const listHeight = Math.max(1, height - 3); // -filter-row -2 borders
  const halfWindow = Math.floor(listHeight / 2);
  const scrollStart = Math.max(0, Math.min(rows.length - listHeight, selectedIdx - halfWindow));
  const visible = rows.slice(scrollStart, scrollStart + listHeight);

  return (
    <Box flexDirection="column" width={width} borderStyle={focused ? 'round' : 'single'} borderColor={focused ? 'cyan' : undefined}>
      <Box>
        <Text dimColor>filter </Text>
        <Text color={filterFocused ? 'cyan' : undefined} inverse={filterFocused && filter.length === 0}>
          {filter || (filterFocused ? ' ' : '—')}
        </Text>
        {filterFocused && filter.length > 0 && <Text color="cyan">▌</Text>}
      </Box>
      <Box height={listHeight} flexDirection="column">
        {visible.length === 0 ? (
          <Text dimColor> (no matches)</Text>
        ) : (
          visible.map((row, i) => {
            const absoluteIdx = scrollStart + i;
            const isSelected = absoluteIdx === selectedIdx;
            return (
              <Box key={row.hwnr}>
                <Text color={isSelected ? 'cyan' : undefined} inverse={isSelected && focused}>
                  {isSelected ? '▸ ' : '  '}
                  {row.hwnr}
                  <Text dimColor>  {row.sgTyp}</Text>
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}

// ── right panel: details for selected HWNR ──────────────────────────

function DetailsPanel({
  row,
  candidates,
  zbAlt,
  zbAltFocused,
  upgrade,
  width,
  height,
}: {
  row: HwnrRow | undefined;
  candidates: FlashCandidate[];
  zbAlt: string;
  zbAltFocused: boolean;
  upgrade: NpvRow | undefined;
  width: number;
  height: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle={zbAltFocused ? 'round' : 'single'} borderColor={zbAltFocused ? 'cyan' : undefined}>
      {!row ? (
        <Text dimColor>  no HWNR selected</Text>
      ) : (
        <>
          <Box>
            <Text bold color="green"> HWNR </Text>
            <Text>{row.hwnr}</Text>
            <Text dimColor>   SG_TYP </Text>
            <Text>{row.sgTyp}</Text>
            {row.atHwnr !== '0000000' && (
              <>
                <Text dimColor>   replacement </Text>
                <Text>{row.atHwnr}</Text>
              </>
            )}
          </Box>

          <Box>
            <Text dimColor> ZB-Alt </Text>
            <Text color={zbAltFocused ? 'cyan' : undefined} inverse={zbAltFocused && zbAlt.length === 0}>
              {zbAlt || (zbAltFocused ? ' ' : '—')}
            </Text>
            {zbAltFocused && zbAlt.length > 0 && <Text color="cyan">▌</Text>}
          </Box>

          {candidates.length === 0 ? (
            <Text color="yellow"> no SG_TYP resolved (HWNR is in HWNR.DA2 but not in KFCONF)</Text>
          ) : (
            candidates.map((c, i) => (
              <CandidateBlock key={c.sgTyp + i} candidate={c} index={i} total={candidates.length} hwnr={row.hwnr} />
            ))
          )}

          {zbAlt.trim() !== '' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow"> Upgrade for ZB-{zbAlt.trim()}</Text>
              {upgrade ? (
                <Box>
                  <Text>   → </Text>
                  <Text bold color="green">ZB-{upgrade.zbNeu}</Text>
                  <Text dimColor>   via NP-SW </Text>
                  <Text>{upgrade.npSw}</Text>
                  <Text dimColor>   mask </Text>
                  <Text>{upgrade.am}</Text>
                </Box>
              ) : (
                <Text dimColor>   no NPV row for this ZB-Alt</Text>
              )}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

function CandidateBlock({
  candidate,
  index,
  total,
  hwnr,
}: {
  candidate: FlashCandidate;
  index: number;
  total: number;
  hwnr: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow"> [{index + 1}/{total}] {candidate.sgTyp}</Text>

      <Text dimColor>   Compatible HWNRs ({candidate.hwnrRows.length})</Text>
      {candidate.hwnrRows.slice(0, 8).map((r) => (
        <Box key={r.hwnr + ':' + r.lineNo}>
          <Text color={r.hwnr === hwnr ? 'cyan' : undefined}>
            {r.hwnr === hwnr ? '   ▶ ' : '     '}
            {r.hwnr}
          </Text>
          {r.atHwnr !== '0000000' && <Text dimColor> (→ {r.atHwnr})</Text>}
        </Box>
      ))}
      {candidate.hwnrRows.length > 8 && (
        <Text dimColor>     … {candidate.hwnrRows.length - 8} more</Text>
      )}

      {candidate.kfConfRows.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>   Coding variants ({candidate.kfConfRows.length})</Text>
          {candidate.kfConfRows.slice(0, 3).map((k, i) => (
            <Text key={i}>
              <Text dimColor>     0x{k.variantHex}</Text>
              <Text dimColor>  v{k.version}</Text>
              <Text dimColor>  IPO </Text>
              {k.ipoFile}
              <Text dimColor>  SGBD </Text>
              {k.flashSgbd}
            </Text>
          ))}
          {candidate.kfConfRows.length > 3 && (
            <Text dimColor>     … {candidate.kfConfRows.length - 3} more</Text>
          )}
        </Box>
      )}

      {candidate.prgIfSel && (
        <Box>
          <Text dimColor>   Transport </Text>
          <Text>{candidate.prgIfSel.protocol}</Text>
          <Text dimColor>  (via {candidate.prgIfSel.sgName})</Text>
        </Box>
      )}
    </Box>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function useStdoutDimensions(): [number, number] {
  const { stdout } = useStdout();
  const [dims, setDims] = useState<[number, number]>([stdout.columns || 80, stdout.rows || 24]);
  useEffect(() => {
    const handler = () => setDims([stdout.columns || 80, stdout.rows || 24]);
    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout]);
  return dims;
}

function truncatePath(path: string, max: number): string {
  if (path.length <= max) return path;
  if (max <= 3) return path.slice(-max);
  return '…' + path.slice(-(max - 1));
}
