// Capture d'écran opt-in — différenciateur mobile-first (PDF §11).
// Best-effort, jamais bloquant : si `react-native-view-shot` n'est pas
// installé, on skip silencieusement.

let rootRef: { current: unknown } | null = null;

export function setRootRef(ref: { current: unknown } | null): void {
  rootRef = ref;
}

export async function captureScreenshot(quality = 0.5): Promise<string | undefined> {
  if (!rootRef?.current) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ViewShot = require('react-native-view-shot') as {
      captureRef?: (
        ref: unknown,
        opts: {
          format: 'png' | 'jpg';
          quality?: number;
          result: 'data-uri' | 'base64' | 'tmpfile';
        },
      ) => Promise<string>;
    };
    if (!ViewShot?.captureRef) return undefined;
    return await ViewShot.captureRef(rootRef.current, {
      format: 'jpg',
      quality,
      result: 'data-uri',
    });
  } catch {
    return undefined;
  }
}
