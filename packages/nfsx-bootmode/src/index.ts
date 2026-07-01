/**
 * @emdzej/nfsx-bootmode — bootmode (C167 BSL) flashing for BMW MS42/MS43.
 *
 * Browser-safe surface. High-level API: `readFullFlash`, `writeFullFlash`,
 * `probeBootmode`. The caller passes in an already-opened `BootmodeTransport`
 * plus a `BundleLoader` supplying the MiniMon / stub blobs.
 *
 * For the Node convenience — `NodeBootmodeTransport` + FS-backed bundle
 * loader (`createNodeBundleLoader`) — import from
 * `@emdzej/nfsx-bootmode/node`.
 */
export {
  readFullFlash,
  writeFullFlash,
  readFullFlashJmg,
  writeFullFlashJmg,
  probeBootmode,
  describeBundle,
  C167CR_BSL_ID,
  type BootmodeSessionConfig,
  type BootmodeProgress,
  type BootmodeProgressFn,
  type WriteFlashOptions,
} from './session.js';

export {
  performHandshake,
  BootmodeHandshakeError,
  MINIMON_LOADER_STARTED,
  MINIMON_APPLICATION_STARTED,
  type HandshakeOptions,
} from './handshake.js';

export {
  MinimonClient,
  MinimonError,
  A_ACK1,
  A_ACK2,
  C_WRITE_WORD,
  C_READ_WORD,
  C_WRITE_BLOCK,
  C_READ_BLOCK,
  C_CALL_FUNCTION,
  C_GETCHECKSUM,
} from './minimon.js';

export {
  MockBootmodeTransport,
  type BootmodeTransport,
  type BootmodeTransportConfig,
} from './transport-interface.js';

export {
  parseIntelHex,
  flattenIntelHex,
  IntelHexParseError,
  type IntelHexBlock,
  type IntelHexResult,
} from './intel-hex.js';

export {
  assertBundleIntegrity,
  type BundleLoader,
  type BundleBlob,
  type BundleManifest,
  type BlobIntegrity,
  type IntegrityReport,
} from './bundle-loader.js';

export {
  JmgClient,
  JmgClientError,
  JMG_ACK,
  CMD_EINIT,
  CMD_ERASE,
  CMD_READ,
  CMD_PROGRAM,
  JMG_PAGE_SIZE,
  JMG_TOTAL_PAGES,
} from './jmg-client.js';

export {
  concatU8,
  le16,
  le24,
} from './bytes.js';
