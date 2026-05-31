/**
 * @emdzej/nfsx-bootmode — bootmode (C167 BSL) flashing for BMW MS42/MS43.
 *
 * High-level API: `readFullFlash`, `writeFullFlash`, `probeBootmode`.
 * Low-level pieces (`MinimonClient`, `FlashDriver`, `performHandshake`,
 * `NodeBootmodeTransport`) are also exported for advanced use.
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
  FlashDriver,
  FlashDriverError,
  AM29F400BB_SECTORS,
  AM29F400B_TOTAL_BYTES,
  DEFAULT_DRIVER_ADDRESS,
  FC_PROG,
  FC_ERASE,
  FC_GETSTATE,
  type SectorLayout,
} from './flash-driver.js';

export {
  NodeBootmodeTransport,
  MockBootmodeTransport,
  type BootmodeTransport,
  type BootmodeTransportConfig,
} from './transport.js';

export {
  parseIntelHex,
  flattenIntelHex,
  IntelHexParseError,
  type IntelHexBlock,
  type IntelHexResult,
} from './intel-hex.js';

export {
  verifyBundleIntegrity,
  assertBundleIntegrity,
  loadBundleManifest,
  readBundledBlob,
  type BundleBlob,
  type BundleManifest,
  type BlobIntegrity,
  type IntegrityReport,
} from './manifest.js';

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
