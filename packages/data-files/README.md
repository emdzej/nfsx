# @emdzej/nfsx-data-files

Plaintext parsers for BMW NFS / WinKFP data files — the inputs to
the flash planner.

All file formats are line-oriented plaintext. The `.DA2` / `.AS2`
extensions are versioned-format naming (not binary v2). See
[`../../docs/architecture.md §9.2`](../../docs/architecture.md#92-file-format-reference-priorities-for-parser-implementation)
for the full format reference.

## Status

| File | Parser | Status |
|---|---|---|
| `kmm_SIT.txt` | `parseKmmSit` | ✅ |
| `kmm_SG.txt`, `kmm_SGK.txt`, `kmm_SWT.txt`, … (15 others) | — | ⏳ pending non-E46 SP-Daten samples |
| `HWNR.DA2` | — | ⏳ |
| `KFCONF10.DA2` | — | ⏳ |
| `SGIDC.AS2`, `SGIDD.AS2` | — | ⏳ |
| `npv.dat` | — | ⏳ |
| `prgifsel.dat` | — | ⏳ |

## Usage

```typescript
import { parseKmmSit } from '@emdzej/nfsx-data-files';
import { readFileSync } from 'node:fs';

const content = readFileSync('kmm_SIT.txt', { encoding: 'latin1' });
const file = parseKmmSit(content);

for (const row of file.rows) {
  console.log(`0x${row.diagAddr.toString(16)} ${row.shortName} ${row.transport}`);
}

for (const err of file.unparsed) {
  console.warn(`line ${err.lineNo}: ${err.reason}`);
}
```

## Conventions

- **Encoding**: BMW ships files as ISO-8859-1 / Latin-1 (umlauts in
  comments). Read the file with `encoding: 'latin1'` upstream; the
  parsers take JS strings and don't care about encoding.
- **Error model**: rows that fail to parse land in `unparsed` rather
  than throwing. A single malformed row in a 3000-row file
  shouldn't sink the whole load.
- **Raw preserved**: every parsed row carries `raw: string[]` for
  forward-compat — unknown enum values stay round-trippable.
