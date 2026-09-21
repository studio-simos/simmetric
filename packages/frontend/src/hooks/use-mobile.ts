// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {useState, useEffect} from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

// useBelowLg (lg=1024px viewport probe) was REMOVED by the quick-260921-o5z
// knip sweep: its last consumer (ChatPanel's below-lg responsive split) was
// replaced by pure CSS (`lg:hidden` trigger + RightPanel's internal
// `hidden lg:flex`) in the R-2/R-3 UI revision (fb2524eb, 2026-09-09) — the
// hook had zero references since then. Re-introduce via useIsMobile's pattern
// (matchMedia on a 1023px max-width) if a JS-side lg probe is ever needed.
