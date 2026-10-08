import Con from '../../source/engine/common/Console.ts';
import { engineMocks } from './engineMocks.ts';

/**
 * Lets a test that still mocks `engineMocks.Con` capture what the shared console prints: the engine's
 * parts import the console directly now, so it hands everything to whatever `engineMocks.Con` is at the time,
 * and prints nothing when that is not set. Importing this file installs the bridge; it goes away together
 * with the registry.
 */
type Print = (text: string, color?: unknown) => void;

interface MockedConsole {
  Print?: Print;
  DPrint?: Print;
  PrintWarning?: Print;
  PrintError?: Print;
  PrintSuccess?: Print;
  StartCapturing?: () => void;
  StopCapturing?: () => string;
}

const mocked = (): MockedConsole | undefined => engineMocks.Con as unknown as MockedConsole | undefined;

Con.useDelegate({
  Print: (text, color) => { if (color === undefined) { mocked()?.Print?.(text); } else { mocked()?.Print?.(text, color); } },
  DPrint: (text) => { mocked()?.DPrint?.(text); },
  PrintWarning: (text) => { mocked()?.PrintWarning?.(text); },
  PrintError: (text) => { mocked()?.PrintError?.(text); },
  PrintSuccess: (text) => { mocked()?.PrintSuccess?.(text); },
  StartCapturing: () => { mocked()?.StartCapturing?.(); },
  StopCapturing: () => mocked()?.StopCapturing?.() ?? '',
});
