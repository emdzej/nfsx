export {
  parseS37,
  parseLine,
  computeChecksum,
  dataRecords,
  startRecord,
  type S37Record,
  type S37ParseResult,
} from './s37.js';

export {
  buildMemoryMap,
  chunkRegion,
  type MemoryRegion,
  type BuildMemoryMapResult,
} from './memory-map.js';

export { verifyChecksums, crc32, crc32Regions } from './integrity.js';

export {
  parsePaDa,
  paDaToRegions,
  parseHexRecord,
  type PaDaRecord,
  type PaDaMetadata,
  type PaDaParseResult,
} from './pa-da.js';

export {
  crc16Ccitt,
  add32,
  detectVariant,
  verifyChecksums as verifyMs4xChecksums,
  rewriteChecksums as rewriteMs4xChecksums,
  EXPECTED_FILE_LENGTH as MS4X_EXPECTED_FILE_LENGTH,
  type EcuVariant as Ms4xEcuVariant,
  type ChecksumResult as Ms4xChecksumResult,
  type ChecksumReport as Ms4xChecksumReport,
  type ChecksumName as Ms4xChecksumName,
  type ChecksumKind as Ms4xChecksumKind,
  type ChecksumRange as Ms4xChecksumRange,
  type VerifyChecksumsOptions as Ms4xVerifyChecksumsOptions,
} from './ms4x-checksum.js';
