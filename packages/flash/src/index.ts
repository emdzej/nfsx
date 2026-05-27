export { FlashSession } from './session.js';
export { runPrecheck, type PrecheckReport, type PrecheckEntry } from './precheck.js';
export {
  runBackup,
  writeBackupFile,
  defaultBackupFilename,
  DEFAULT_BACKUP_JOBS,
  ZIF_BACKUP_NOT_AVAILABLE,
  type BackupReport,
} from './backup.js';
export {
  runProgramSg,
  runAifSchreiben,
  type ProgramOptions,
  type ProgramReport,
} from './prog-sg.js';
export {
  rejectAllConfirmation,
  allowAllConfirmation,
  buildPromptConfirmation,
} from './safety.js';
export type {
  Stage,
  EcuTarget,
  PrecheckOptions,
  BackupOptions,
  RunOptions,
  ConfirmContext,
  FlashEvent,
  FlashResult,
  FlashSessionOptions,
} from './types.js';
