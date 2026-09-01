// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Component, type ErrorInfo, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

interface ErrorBoundaryProps {
  children: ReactNode;
  t: TFunction<"translation", undefined>;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundaryInner extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] React rendering error:", error);
    console.error("[ErrorBoundary] Component stack:", info.componentStack);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const { t } = this.props;
      return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-4">
          <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 text-center shadow-lg">
            <div className="mb-4 text-4xl" aria-hidden="true">
              ⚠️
            </div>
            <h1 className="mb-2 text-xl font-semibold text-[var(--text)]">
              {t("common.unexpectedError")}
            </h1>
            <p className="mb-6 text-sm text-[var(--text-muted)]">
              {t("common.errorBoundaryDescription")}
            </p>
            {this.state.error && (
              <details className="mb-6 text-left">
                <summary className="cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
                  {t("common.errorDetails")}
                </summary>
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-[var(--code-bg)] p-3 text-xs text-[var(--code-text)]">
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
            >
              {t("common.reloadPage")}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * ErrorBoundary — catches React rendering errors and displays a fallback UI.
 *
 * Wraps an inner class component (required by React for error boundaries)
 * with a functional component to access i18n hooks.
 */
export default function ErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return <ErrorBoundaryInner t={t}>{children}</ErrorBoundaryInner>;
}
