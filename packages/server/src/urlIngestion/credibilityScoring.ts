// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Credibility Scoring Engine
 *
 * Computes an auto-suggest credibility score (1-5) for ingested URLs
 * based on heuristic signals. Users can override the auto-suggested score
 * during ingestion workflow.
 *
 * Signals:
 * 1. Domain authority (TLD-based): .gov/.edu/.mil → +2, .org → +1
 * 2. HTTPS: secure connection → +1, HTTP → -1
 * 3. Author presence: byline detected → +1
 * 4. Publication date: date pattern in URL → +1
 * 5. Substantive content: >5000 chars → +1, <500 chars → -1
 *
 * Formula: start from 3 (neutral baseline), apply signal bonuses/penalties,
 * clamp to 1-5 range, round to nearest integer.
 */

export interface CredibilitySignal {
  name: string;
  present: boolean;
  label: string;
  description: string;
}

export interface CredibilityResult {
  score: number;
  signals: CredibilitySignal[];
  explanation: string;
  autoSuggested: boolean;
}

// Date pattern regex: matches YYYY/MM/DD, YYYY-MM-DD, YYYYMMDD, and common year-only patterns
const DATE_PATTERN = /\b(20\d{2})[/-]?(0[1-9]|1[0-2])[/-]?(0[1-9]|[12]\d|3[01])\b/;

/**
 * Extract the TLD from a URL for domain authority classification.
 */
function extractTLD(url: string): string {
  try {
    // Simple extraction: find the last dot after the protocol separator
    const withoutProtocol = url.replace(/^https?:\/\//, "");
    const hostname = withoutProtocol.split("/")[0]!.split("?")[0]!.split("#")[0]!;
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      // Return the last part (actual TLD), skipping country codes like .co.uk
      const lastPart = parts[parts.length - 1]!;
      // Check for common second-level TLDs
      const secondLast = parts[parts.length - 2]!;
      if (
        parts.length >= 3 &&
        ["co", "com", "org", "gov", "edu", "ac", "net"].includes(secondLast)
      ) {
        return secondLast; // e.g., "co" from .co.uk, "gov" from .gov.au
      }
      return lastPart;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Compute a credibility score (1-5) for a URL based on heuristic signals.
 *
 * @param url - The URL to evaluate
 * @param metadata - Optional metadata: title, byline, siteName, contentLength
 * @returns CredibilityResult with score, signals, and human-readable explanation
 */
export function computeCredibilityScore(
  url: string,
  metadata: {
    title?: string;
    byline?: string | null;
    siteName?: string | null;
    contentLength?: number;
  }
): CredibilityResult {
  // Initialize baseline
  let score = 3;

  // --- Signal 1: Domain authority (TLD check) ---
  const tld = extractTLD(url);
  let domainAuthorityPresent = false;
  let domainDescription = "";

  if (["gov", "edu", "mil"].includes(tld)) {
    score += 2;
    domainAuthorityPresent = true;
    domainDescription = `.${tld} domain — high authority source`;
  } else if (tld === "org") {
    score += 1;
    domainAuthorityPresent = true;
    domainDescription = `.org domain — moderate authority`;
  } else {
    domainDescription = `No recognized authority TLD detected`;
  }

  // --- Signal 2: HTTPS ---
  let httpsPresent = false;
  let httpsDescription = "";

  if (url.startsWith("https://")) {
    score += 1;
    httpsPresent = true;
    httpsDescription = "HTTPS connection — encrypted and secure";
  } else if (url.startsWith("http://")) {
    score -= 1;
    httpsDescription = "HTTP connection — insecure, unencrypted";
  } else {
    httpsDescription = "Unknown protocol";
  }

  // --- Signal 3: Author presence ---
  const hasAuthor = !!(metadata.byline && metadata.byline.trim().length > 0);

  if (hasAuthor) {
    score += 1;
  }

  // --- Signal 4: Publication date ---
  const hasDate = DATE_PATTERN.test(url);

  if (hasDate) {
    score += 1;
  }

  // --- Signal 5: Content length (proxy for substantive content) ---
  const contentLen = metadata.contentLength ?? 0;

  if (contentLen > 5000) {
    score += 1;
  } else if (contentLen < 500 && contentLen > 0) {
    score -= 1;
  }

  // Clamp to 1-5 and round
  score = Math.max(1, Math.min(5, Math.round(score)));

  // Build signals array
  const signals: CredibilitySignal[] = [
    {
      name: "Domain authority",
      present: domainAuthorityPresent,
      label: "Domain authority",
      description: domainDescription,
    },
    {
      name: "HTTPS",
      present: httpsPresent,
      label: "HTTPS",
      description: httpsDescription,
    },
    {
      name: "Author detected",
      present: hasAuthor,
      label: "Author detected",
      description: hasAuthor
        ? "Article has a named author"
        : "No author information available",
    },
    {
      name: "Publication date",
      present: hasDate,
      label: "Publication date",
      description: hasDate
        ? "Publication date detected in URL"
        : "No publication date detected",
    },
    {
      name: "Substantive content",
      present: contentLen > 5000,
      label: "Substantive content",
      description:
        contentLen > 5000
          ? `Long-form content (${contentLen} chars)`
          : contentLen < 500 && contentLen > 0
            ? `Very short content (${contentLen} chars)`
            : "Moderate content length",
    },
  ];

  // Build explanation
  const presentLabels = signals
    .filter((s) => s.present)
    .map((s) => s.label);

  const negativeLabels = signals
    .filter((s) => !s.present)
    .map((s) => `No ${s.label.toLowerCase()}`);

  let explanation = `Score ${score}/5: ${presentLabels.length > 0 ? presentLabels.join(", ") + ". " : ""}`;

  if (negativeLabels.length > 0 && negativeLabels.length < 5) {
    explanation += `${negativeLabels.join(", ")}.`;
  }

  return {
    score,
    signals,
    explanation,
    autoSuggested: true,
  };
}
