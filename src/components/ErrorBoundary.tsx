import React, { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    (this as any).state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught React Error:', error, errorInfo);
    (this as any).setState({ errorInfo });

    try {
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: error.message,
          stack: error.stack,
          componentStack: errorInfo.componentStack,
        }),
      }).catch(() => {});
    } catch (e) {
      // Ignore network failure
    }
  }

  private handleReset = () => {
    (this as any).setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  public render() {
    const state = (this as any).state as State;
    const props = (this as any).props as Props;

    if (state.hasError) {
      return (
        <div className="min-h-[400px] w-full flex flex-col items-center justify-center p-6 bg-[#0c0c12] border border-crypto-danger/50 text-crypto-text font-mono my-4 shadow-2xl">
          <div className="flex items-center gap-3 text-crypto-danger mb-4">
            <AlertTriangle className="w-8 h-8 animate-bounce" />
            <h2 className="text-xl font-bold uppercase tracking-widest">Interface Render Recovery</h2>
          </div>
          <p className="text-xs text-[#a0a0a0] mb-4 max-w-lg text-center leading-relaxed">
            A temporary component render exception was intercepted. The engine core is continuing to run uninterrupted in the background.
          </p>
          <div className="p-3 bg-black/60 border border-crypto-danger/30 text-crypto-danger text-xs max-w-xl w-full mb-6 overflow-x-auto whitespace-pre-wrap font-mono">
            {state.error?.toString()}
          </div>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-6 py-3 bg-crypto-danger text-white font-bold tracking-widest uppercase hover:bg-red-600 transition shadow-[0_0_15px_rgba(239,68,68,0.5)] cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Reload & Recover UI</span>
          </button>
        </div>
      );
    }

    return props.children;
  }
}
