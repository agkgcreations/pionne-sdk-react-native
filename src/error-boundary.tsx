// React Error Boundary intégrée — capte les erreurs lancées pendant le render
// (que `ErrorUtils.setGlobalHandler` ne voit PAS).
// Usage:
//   <PionneErrorBoundary fallback={<MyErrorScreen />}>
//     <App />
//   </PionneErrorBoundary>

import { Component, type ErrorInfo, type ReactNode } from 'react';

// Évite l'import circulaire: on accède à Pionne via globalThis (set par index.ts
// au moment de l'init). Pas besoin d'API magique — c'est juste pour casser le cycle.
import type { Pionne as PionneType } from './index';

type Props = {
  children: ReactNode;
  /** Render quand une erreur a été captée. Reçoit l'erreur + reset(). */
  fallback?: ReactNode | ((args: { error: Error; reset: () => void }) => ReactNode);
  /** Tags ajoutés à l'event Pionne. */
  tags?: Record<string, string>;
  /** Hook custom appelé après la capture. */
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
        // @ts-expect-error — contexts.react n'est pas dans PionneContexts mais
        // c'est volontaire: backend l'accepte en clé libre dans payload.contexts.
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
