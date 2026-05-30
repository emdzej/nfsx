/**
 * @emdzej/nfsx-directmode — raw DS2 flashing for BMW MS42 / MS43 / GS20.
 *
 * Direct K-line DS2 protocol via the normal diagnostic session (no
 * IPO, no SGBD). Distinguishes FULL vs CALIBRATION-only flash via
 * per-ECU region tables, with ECU detection driven by the IDENT
 * response.
 */

export {
  probe,
  writeFlash,
  readFlash,
  runIdent,
  DirectModeError,
  type DirectModeSessionConfig,
  type DirectModeProgress,
  type DirectModeProgressFn,
  type DirectModeWriteOptions,
  type DirectModeWriteResult,
  type DirectModeReadOptions,
} from './session.js';

export {
  encodeFrame,
  decodeFrame,
  calcXor,
  Ds2FrameError,
  DS2_STATUS_OK,
  DS2_STATUS_PENDING,
  DS2_STATUS_TRANSPORT_ERR,
  DS2_STATUS_FRAMING_ERR,
  DS2_CMD_IDENT,
  DS2_CMD_MEMORY_READ,
  DS2_CMD_CAPABILITY,
  DS2_CMD_SEED_KEY,
  DS2_CMD_PROG_PREFIX,
  DS2_PROG_WRITE,
  DS2_PROG_ERASE,
  DS2_PROG_VERIFY,
  type Ds2Frame,
} from './ds2.js';

export {
  buildSeedRequestPayload,
  buildKeySubmitPayload,
  deriveKey,
  SeedKeyError,
  SEED_KEY_PREFIX,
  SEED_REQUEST_CMD,
  KEY_SUBMIT_CMD,
} from './seed-key.js';

export {
  identifyEcu,
  getProfile,
  pickRegions,
  totalBytesForMode,
  ALL_PROFILES,
  type EcuVariant,
  type FlashMode,
  type FlashRegion,
  type EcuProfile,
} from './ecu-tables.js';

export {
  NodeDirectModeTransport,
  MockDirectModeTransport,
  DirectModeTransportError,
  type DirectModeTransport,
  type DirectModeTransportConfig,
} from './transport.js';
