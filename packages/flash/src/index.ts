export { FlashSession } from './session.js';
export { runPrecheck, type PrecheckReport, type PrecheckEntry } from './precheck.js';
export { runAuthenticate, PassthroughKeyDerivation } from './auth.js';
export { runTransfer, type TransferReport } from './transfer.js';
export { runAifWrite, type AifPayload } from './aif-write.js';
export {
  rejectAllConfirmation,
  allowAllConfirmation,
  buildPromptConfirmation,
  DESTRUCTIVE_STAGES,
} from './safety.js';
export type {
  Stage,
  EcuTarget,
  PrecheckOptions,
  KeyDerivationStrategy,
  TransferOptions,
  RunOptions,
  ConfirmContext,
  FlashEvent,
  FlashResult,
  FlashSessionOptions,
} from './types.js';
