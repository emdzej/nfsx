/**
 * Shared "build a real EDIABAS-X provider" helper for the `nfsx` CLI.
 *
 * Both `nfsx run` and `nfsx flash` need the same path:
 *
 *   ~/.config/ediabasx/config.json   ← reused config (same shape as ediabasx-cli)
 *           +
 *   CLI overrides (--interface, --serial-port, --gateway, --simulation)
 *           ↓
 *   createInterface(name, options)   ← @emdzej/ediabasx-interfaces
 *           ↓
 *   new Ediabas({ ecuPath, transport })
 *           ↓
 *   new EdiabasXProvider({ instance, autoConnect })
 *           ↓
 *   provider.init()                  ← runtime/flash never calls this
 *
 * SP-Daten provides `ecuPath` as `<spDaten>/ecu`.
 */

import { join } from 'node:path';
import { EdiabasXProvider } from '@emdzej/inpax-ediabasx-provider';
import { Ediabas } from '@emdzej/ediabasx-ediabas';
import { createInterface } from '@emdzej/ediabasx-interfaces';
import { resolveSpDaten } from './config.js';
import {
  loadEdiabasxConfig,
  resolveEdiabasSelection,
  summariseEdiabasSelection,
} from './ediabasx-config.js';

/** Subset of CLI flags this builder needs — passed by both `run` and `flash`. */
export interface EdiabasProviderFlags {
  ediabasConfig?: string;
  interface?: string;
  serialPort?: string;
  serialBaud?: number;
  gateway?: string;
  spDaten?: string;
  config?: string;
}

export interface BuiltEdiabasProvider {
  provider: EdiabasXProvider;
  cleanup: () => Promise<void>;
  summary: string;
}

export async function buildEdiabasProvider(
  flags: EdiabasProviderFlags,
): Promise<BuiltEdiabasProvider> {
  const spDaten = resolveSpDaten({ spDaten: flags.spDaten, configPath: flags.config });
  const ecuPath = join(spDaten, 'ecu');

  const fileConfig = loadEdiabasxConfig(flags.ediabasConfig);
  const selection = resolveEdiabasSelection(fileConfig, {
    interfaceName: flags.interface,
    serialPort: flags.serialPort,
    serialBaud: flags.serialBaud,
    gateway: flags.gateway,
  });

  // Real-vs-simulation is decided by `selection.interface` — that's
  // ediabasx's responsibility, not ours. See [[feedback-ediabasx-responsibility]].
  const useSimulation = selection.interface === 'simulation';
  const transport = useSimulation
    ? undefined
    : createInterface(selection.interface, selection.options);

  const ediabas = new Ediabas({
    ecuPath,
    transport,
    simulation: useSimulation,
  });

  const provider = new EdiabasXProvider({ instance: ediabas, autoConnect: !useSimulation });

  // Neither nfsx-runtime nor FlashSession calls `provider.init()` on
  // its own (both accept an already-initialised IEdiabasProvider).
  // With `autoConnect: true`, EdiabasXProvider's init() opens the
  // underlying transport and runs `ediabas.connect()`.
  await provider.init();

  return {
    provider,
    cleanup: async () => {
      await provider.end();
    },
    summary: summariseEdiabasSelection(selection),
  };
}
