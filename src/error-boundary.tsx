// Built-in React Error Boundary — captures errors thrown during render
// (which `ErrorUtils.setGlobalHandler` does NOT see).
// Usage:
//   <PionneErrorBoundary fallback={<MyErrorScreen />}>
//     <App />
//   </PionneErrorBoundary>

import { Component, type ErrorInfo, type ReactNode } from 'react';

// Avoids the circular import: we reach Pionne via globalThis (set by index.ts
// at init time). No magic API — it's just to break the cycle.
import type { Pionne as PionneType } from './index';

type Props = {
  children: ReactNode;
  /** Rendered when an error has been captured. Receives the error + reset(). */
  fallback?: ReactNode | ((args: { error: Error; reset: () => void }) => ReactNode);
  /** Tags added to the Pionne event. */
  tags?: Record<string, string>;
  /** Custom hook called after capture. */
  onError?: (error: Error, info: ErrorInfo) => void;
};

type State = { error: Error | null };

declare const globalThis: { __pionne?: typeof PionneType };

export class PionneErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const Pionne = globalThis.__pionne;
    Pionne?.captureException(error, {
      level: 'error',
      mechanism: { type: 'react_error_boundary', handled: false },
      tags: this.props.tags,
      contexts: {
        // @ts-expect-error — contexts.react is not in PionneContexts but this
        // is intentional: the backend accepts it as a free key in payload.contexts.
        react: { component_stack: info.componentStack },
      },
    });
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      const fb = this.props.fallback;
      if (typeof fb === 'function') {
        return fb({ error: this.state.error, reset: this.reset });
      }
      return fb ?? null;
    }
    return this.props.children;
  }
}
