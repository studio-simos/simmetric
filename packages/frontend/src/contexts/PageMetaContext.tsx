// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import React, { createContext, useState } from "react";

export interface BreadcrumbSegment {
  label: string;
  path?: string;
}

interface PageMetaState {
  title: string;
  breadcrumbs: BreadcrumbSegment[];
}

interface PageMetaContextValue extends PageMetaState {
  setPageMeta: (title: string, breadcrumbs?: BreadcrumbSegment[]) => void;
  clearPageMeta: () => void;
}

const PageMetaContext = createContext<PageMetaContextValue | null>(null);

// Module-level mutable state for imperative setters
let pageMetaSetters: {
  setTitle: (t: string) => void;
  setBreadcrumbs: (b: BreadcrumbSegment[]) => void;
} | null = null;

const initialState: PageMetaState = { title: "", breadcrumbs: [] };

export function PageMetaProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = useState(initialState.title);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbSegment[]>(initialState.breadcrumbs);

  const setPageMeta = (newTitle: string, newBreadcrumbs: BreadcrumbSegment[] = []) => {
    setTitle(newTitle);
    setBreadcrumbs(newBreadcrumbs);
  };

  const clearPageMeta = () => {
    setTitle(initialState.title);
    setBreadcrumbs(initialState.breadcrumbs);
  };

  // Expose setters to module-level imperative API
  React.useEffect(() => {
    pageMetaSetters = { setTitle, setBreadcrumbs };
    return () => { pageMetaSetters = null; };
  }, [setTitle, setBreadcrumbs]);

  return (
    <PageMetaContext.Provider value={{ title, breadcrumbs, setPageMeta, clearPageMeta }}>
      {children}
    </PageMetaContext.Provider>
  );
}

// Phase 180 dead-code sweep: the raw context-consumer hook `usePageMeta()`
// was REMOVED — consumers use the wrapper `hooks/usePageMeta.ts` (effect
// lifecycle + serialized-breadcrumb deps) with the imperative
// setPageMeta/clearPageMeta exports below.

export function setPageMeta(title: string, breadcrumbs?: BreadcrumbSegment[]): void {
  if (pageMetaSetters) {
    pageMetaSetters.setTitle(title);
    pageMetaSetters.setBreadcrumbs(breadcrumbs || []);
  }
}

export function clearPageMeta(): void {
  if (pageMetaSetters) {
    pageMetaSetters.setTitle("");
    pageMetaSetters.setBreadcrumbs([]);
  }
}
