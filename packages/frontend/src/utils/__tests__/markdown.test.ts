// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { renderMarkdown, preprocessBareFileRefs } from "../markdown";

describe("renderMarkdown file refs with spaces in filenames", () => {
  it("renders a bare filename with spaces as a single full-name file-ref span", () => {
    const html = renderMarkdown("See Guida Installazione.md for details.");
    expect(html).toContain('<span class="file-ref" data-file-link="Guida Installazione.md"');
    expect(html).not.toContain('href="http://Installazione.md"');
    expect(html.match(/data-file-link="/g) ?? []).toHaveLength(1);
  });

  it("renders 'Source: Guida Installazione.md' as one full-name file-ref", () => {
    const html = renderMarkdown("Source: Guida Installazione.md");
    expect(html).toContain('<span class="file-ref" data-file-link="Guida Installazione.md"');
    expect(html).not.toContain("http://Installazione.md");
    expect(html.match(/data-file-link="/g) ?? []).toHaveLength(1);
  });

  it("handles the raw_sources/ prefix (label keeps prefix, data-file-link carries basename)", () => {
    const html = renderMarkdown("vedi raw_sources/Guida Installazione.md");
    expect(html).toContain('<span class="file-ref" data-file-link="Guida Installazione.md"');
    expect(html).toContain("raw_sources/Guida Installazione.md");
  });

  it("renders multiple filenames with spaces as separate file-ref spans", () => {
    const html = renderMarkdown("Per info vedi Guida Installazione.md e Report Finale.pdf");
    expect(html).toContain('data-file-link="Guida Installazione.md"');
    expect(html).toContain('data-file-link="Report Finale.pdf"');
    expect(html.match(/data-file-link="/g) ?? []).toHaveLength(2);
  });

  it("keeps single-word filenames as file-refs (no-space regression)", () => {
    const html = renderMarkdown("foo.md");
    expect(html).toContain('<span class="file-ref" data-file-link="foo.md"');
    expect(html).not.toContain('target="_blank"');
  });

  it("leaves real URLs untouched (no file-ref span, target=_blank kept)", () => {
    const html = renderMarkdown("https://example.com/report.pdf");
    expect(html).toContain('<a href="https://example.com/report.pdf"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("file-ref");
  });

  it("leaves code spans untouched", () => {
    const html = renderMarkdown("code: `Guida Installazione.md`");
    expect(html).toContain("<code>Guida Installazione.md</code>");
    expect(html).not.toContain("file-ref");
  });

  it("leaves explicit markdown links untouched", () => {
    const html = renderMarkdown("[Guida Installazione.md](https://example.com/x)");
    expect(html).toContain('<a href="https://example.com/x"');
    expect(html).not.toContain("file-ref");
  });

  it("wraps bare filenames with spaces but leaves no-space text unchanged (preprocessor unit)", () => {
    expect(preprocessBareFileRefs("foo.md")).toBe("foo.md");
    expect(preprocessBareFileRefs("See Guida Installazione.md now")).toBe(
      "See [Guida Installazione.md](<Guida Installazione.md>) now",
    );
  });

  it("links the full name in *Source: <name>* citations (3+ words, punctuation)", () => {
    const html = renderMarkdown(
      "*Source: How Elasticsearch Handles Deletions (and Why Our 30TB Purge Didn’t Break Anything).md*",
    );
    expect(html).toContain(
      '<span class="file-ref" data-file-link="How Elasticsearch Handles Deletions (and Why Our 30TB Purge Didn’t Break Anything).md"',
    );
    expect(html).not.toContain("http://");
  });

  it("links the full name in **<name>** strong citations", () => {
    const html = renderMarkdown(
      "1. **Llm Wiki — Karpathy's LLM Wiki buildquery interlinked markdown KB.md**",
    );
    expect(html).toContain(
      '<span class="file-ref" data-file-link="Llm Wiki — Karpathy\'s LLM Wiki buildquery interlinked markdown KB.md"',
    );
    expect(html).not.toContain("http://KB.md");
  });

  it("links the full name in **Source: <name>** citations", () => {
    const html = renderMarkdown("**Source: Announcing the Public Preview of Custom URLs.md**");
    expect(html).toContain(
      '<span class="file-ref" data-file-link="Announcing the Public Preview of Custom URLs.md"',
    );
    expect(html).not.toContain("http://URLs.md");
  });

  it("links the full name in [Source: <name>] citations", () => {
    const html = renderMarkdown("[Source: Guida Installazione.md]");
    expect(html).toContain('<span class="file-ref" data-file-link="Guida Installazione.md"');
    expect(html).not.toContain("http://Installazione.md");
  });

  it("leaves code spans with Source: markers untouched", () => {
    const html = renderMarkdown("code: `Source: Guida Installazione.md`");
    expect(html).toContain("<code>Source: Guida Installazione.md</code>");
    expect(html).not.toContain("file-ref");
  });

  it("links full names in a real chat answer listing wiki documents", () => {
    const html = renderMarkdown(
      [
        "Based on the retrieved information, the workspace contains the following documents:",
        "",
        "1. **Llm Wiki — Karpathy's LLM Wiki buildquery interlinked markdown KB.md**",
        "   Describes a structured wiki architecture.",
        "   *Source: Llm Wiki — Karpathy's LLM Wiki buildquery interlinked markdown KB.md*",
        "",
        "2. **How Elasticsearch Handles Deletions (and Why Our 30TB Purge Didn't Break Anything).md**",
        "   Explains Elasticsearch's approach.",
        "   *Source: How Elasticsearch Handles Deletions (and Why Our 30TB Purge Didn't Break Anything).md*",
      ].join("\n"),
    );
    expect(html).toContain(
      'data-file-link="Llm Wiki — Karpathy\'s LLM Wiki buildquery interlinked markdown KB.md"',
    );
    expect(html).toContain(
      'data-file-link="How Elasticsearch Handles Deletions (and Why Our 30TB Purge Didn\'t Break Anything).md"',
    );
    expect(html).not.toContain("http://KB.md");
    expect(html).not.toContain("http://URLs.md");
  });
});
