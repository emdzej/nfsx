/**
 * @emdzej/nfsx-ms45 — MS45 DME flashing helpers.
 *
 * Offline BIN helpers (CRC-32 verify/rewrite, RSA-512 firmware
 * signing, security-access payload builder, region tables) plus the
 * SGBD-driven `probe` / `readFlash` / `writeFlash` orchestration
 * that talks to a live DME through an `IEdiabas` handle.
 */

export {
  // constants
  EXTERNAL_FLASH_BASE,
  MPC_FLASH_BASE,
  EXTERNAL_FLASH_SIZE,
  MPC_FLASH_SIZE,
  TUNE_BLOB_SIZE,
  TUNE_BLOB_HOST_OFFSET,
  PROGRAM_BLOB_SIZE,
  PROGRAM_BLOB_HOST_OFFSET,
  HW_REF_MS45_0,
  HW_REF_MS45_1,
  // header field offsets
  PARAM_CRC_STORED_OFFSET,
  PARAM_CRC_SEGMENT_TABLE_OFFSET,
  PARAM_CRC_INITIAL_OFFSET,
  PARAM_CRC_SEGMENT_BASE,
  PARAM_SIG_SEGMENT_COUNT_OFFSET,
  PARAM_SIG_SEGMENT_STARTS_OFFSET,
  PARAM_SIG_SEGMENT_LENGTHS_OFFSET,
  PARAM_SIG_SEGMENT_BASE,
  PARAM_SIG_STORED_OFFSET,
  PARAM_SIG_LENGTH,
  PROG_CRC_PRIMARY_STORED_OFFSET,
  PROG_CRC_PRIMARY_INITIAL_OFFSET,
  PROG_CRC_PRIMARY_SEG1_START_OFFSET,
  PROG_CRC_PRIMARY_SEG1_END_OFFSET,
  PROG_CRC_PRIMARY_SEG2_START_OFFSET,
  PROG_CRC_PRIMARY_SEG2_END_OFFSET,
  PROG_CRC_SECONDARY_STORED_OFFSET,
  PROG_CRC_SECONDARY_INITIAL_OFFSET,
  PROG_CRC_SECONDARY_SEG1_START_OFFSET,
  PROG_CRC_SECONDARY_SEG1_END_OFFSET,
  PROG_CRC_SECONDARY_SEG2_START_OFFSET,
  PROG_CRC_SECONDARY_SEG2_END_OFFSET,
  PROG_SIG_SEGMENT_COUNT_OFFSET,
  PROG_SIG_SEGMENT_STARTS_OFFSET,
  PROG_SIG_SEGMENT_LENGTHS_OFFSET,
  PROG_SIG_STORED_OFFSET,
  PROG_SIG_LENGTH,
  // helpers
  readU32BE,
  writeU32BE,
  classifyEcuAddress,
  resolveEcuAddress,
  parseParameterSignedSegments,
  parseProgramSignedSegments,
  // types
  type Ms45Variant,
  type FlashSpace,
  type ResolvedAddress,
  type ParamSignedSegment,
  type ProgramSignedSegment,
} from './regions.js';

export {
  crc32,
  verifyParameterChecksum,
  rewriteParameterChecksum,
  verifyProgramChecksum,
  rewriteProgramChecksum,
  type ParameterChecksumResult,
  type ProgramChecksumResult,
  type ProgramChecksumEntry,
} from './checksum.js';

export {
  // low-level primitives (also useful for test / debug tooling)
  md5,
  modPow,
  bytesLEToBigInt,
  bigIntToBytesLE,
  encodeSignatureBytes,
  signHashedFirmware,
  // constants
  FIRMWARE_MODULUS,
  FIRMWARE_PRIVATE_EXPONENT,
  // verify / rewrite
  verifyParameterSignature,
  rewriteParameterSignature,
  verifyProgramSignature,
  rewriteProgramSignature,
  type SignatureCheckResult,
} from './signature.js';

export {
  // constants
  AUTH_MODULUS,
  AUTH_PRIVATE_EXPONENT,
  AUTH_MESSAGE_HEADER,
  AUTH_MESSAGE_TRAILER,
  AUTH_MESSAGE_LENGTH,
  // helpers
  formatSeedRequestArg,
  extractSerialNumber,
  buildAuthenticationStartArg,
  type AuthMessageInput,
} from './auth.js';

// ── Stage 2: wire-driven session surface ───────────────────────────

export {
  runJob,
  getJobStatus,
  getResultString,
  getResultBinary,
  requireResultString,
  requireResultBinary,
  Ms45JobError,
  type SgbdArg,
} from './ms45-ediabas.js';

export {
  identifyDme,
  classifyVariant,
  isBmwFast,
  type DmeIdent,
} from './ident.js';

export {
  requestSecurityAccess,
  defaultAuthRandom,
  type AuthOptions,
  type AuthResult,
  type AuthRandomSource,
} from './auth-flow.js';

export {
  enterProgrammingMode,
  leaveProgrammingMode,
  suspendNormalTraffic,
} from './session-control.js';

export {
  readMemory,
  MEM_SEGMENT,
  READ_CHUNK_SIZE,
  type MemSegment,
  type ReadMemoryOptions,
} from './read-memory.js';

export {
  eraseRegion,
  buildEraseCommand,
  ERASE_TUNE,
  ERASE_PROGRAM,
  type EraseTarget,
} from './erase.js';

export {
  flashBlock,
  buildFlashAddressCommand,
  buildFlashChunk,
  FLASH_CHUNK_SIZE,
  FLASH_TUNE,
  FLASH_PROGRAM,
  FLASH_MPC,
  type FlashTarget,
  type FlashBlockOptions,
} from './flash-block.js';

export {
  verifyFlashSignature,
  flashProgrammingStatus,
  resetEcu,
  type FlashBlobKind,
} from './verify.js';

export {
  probe,
  readFlash,
  writeFlash,
  Ms45SessionError,
  type Ms45SessionConfig,
  type Ms45Stage,
  type Ms45Progress,
  type Ms45ProgressFn,
  type ReadMode,
  type ReadFlashOptions,
  type ReadFlashResult,
  type WriteMode,
  type WriteCommonOptions,
  type WriteFlashOptions,
  type WriteFlashResult,
} from './session.js';

export {
  MockIEdiabas,
  buildResponse,
  type MockCall,
} from './mock-ediabas.js';
