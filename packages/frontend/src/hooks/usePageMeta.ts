// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect } from "react";
import { setPageMeta, clearPageMeta, type BreadcrumbSegment } from "@/contexts/PageMetaContext";

export function usePageMeta(title: string, breadcrumbs: BreadcrumbSegment[] = []) {
  const serialized = JSON.stringify(breadcrumbs);
  useEffect(() => {
    setPageMeta(title, breadcrumbs);
    return () => {
      clearPageMeta();
    };
    // `breadcrumbs` (the raw array) is intentionally excluded from the deps
    // array — callers recreate the array reference on every render, so listing
    // it would force a re-run every render. `serialized` (its JSON.stringify
    // proxy) is the stable dependency that actually gates re-runs: the effect
    // fires only when the breadcrumb content changes. (D-05 pattern 3 —
    // intentional stale-closure-by-proxy, documented.)
  }, [title, serialized]);
}
