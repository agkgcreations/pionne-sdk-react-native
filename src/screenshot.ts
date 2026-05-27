// Opt-in screenshot capture — mobile-first differentiator.
// Best-effort, never blocking: if `react-native-view-shot` isn't installed
// we skip silently.

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
