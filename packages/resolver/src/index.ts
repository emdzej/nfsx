export {
  loadSpDaten,
  loadSpDatenFromDir,
  loadZbNrTabForSg,
  defaultSpDatenPaths,
  type SpDaten,
  type SpDatenPaths,
} from './load.js';

export {
  resolveByHwnr,
  resolveBySgTyp,
  resolveByDiagAddr,
  resolveUpgrade,
  type FlashCandidate,
} from './resolve.js';
