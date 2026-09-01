// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang }).value}</code></pre>`;
      } catch {
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

// A file-reference link is one whose href looks like a bare filename with an
// extension — e.g. `agents.md`, `config.yml`, `file.txt` — or the same wrapped
// in http(s):// by markdown-it's linkify. We exclude localhost / 127.0.0.1 and
// real domains (those have a dot followed by a TLD AND a path or query).
const LOCAL_HOST_RE = /(?:localhost|127\.0\.0\.1)/;

// The answer pipeline instructs the LLM to cite source document names, and the
// model wraps them in markdown emphasis/strong or a `[Source: ...]` marker —
// e.g. `*Source: How Elasticsearch Handles Deletions (and Why Our 30TB Purge
// Didn't Break Anything).md*`, `**Llm Wiki — Karpathy's LLM Wiki buildquery
// interlinked markdown KB.md**`, `[Source: Name.md]`. These names are 3+ words
// and contain punctuation, so a bare-filename regex cannot see them. Wrap the
// name (without the `Source: ` prefix) in an explicit markdown link with an
// angle-bracket destination. Single-pass alternation: the source/strong forms
// are tried first so the bare-filename alternative never re-matches inside
// their output. The lookbehind rejects matches inside explicit `[label](dest)`
// links (preceded by `[` or `(`/`<`) and inside `[[wikilinks]]`.
const FILE_REF_PREPROCESS_RE =
  /(?<!`)\*\*Source:\s*([^*\n]+\.(?:[a-zA-Z0-9]{1,5}))\*\*|(?<!`)\*\*([^*\n]+\.(?:[a-zA-Z0-9]{1,5}))\*\*|(?<!`)\*Source:\s*([^*\n]+\.(?:[a-zA-Z0-9]{1,5}))\*|(?<!`)\[Source:\s*([^\]\n]+\.(?:[a-zA-Z0-9]{1,5}))\]|(?<![\w.([/`:<])raw_sources\/([\w.-]+(?: [\w.-]+)+\.(?:[a-zA-Z0-9]{1,5}))|(?<![\w.([/`:<)])([\w.-]+ [\w.-]+\.(?:[a-zA-Z0-9]{1,5}))/g;

// markdown-it's linkify splits a bare filename containing spaces — `See Guida
// Installazione.md` tokenizes to text "See Guida " + a hostless link
// `http://Installazione.md` + text "Installazione.md". An inline ruler cannot
// fix this (the `text` rule consumes chars before any position-based rule sees
// the full name), so wrap such filenames in explicit markdown links with
// angle-bracket destinations before rendering — markdown-it parses those into a
// single `<a>` with the spaces URL-encoded and the label verbatim.
export function preprocessBareFileRefs(text: string): string {
  // Protect code spans (inline + fenced) so the regex never touches them.
  const codeSpans: string[] = [];
  const protectedText = text
    .replace(/```[\s\S]*?```/g, (m) => {
      codeSpans.push(m);
      return `\u0000${codeSpans.length - 1}\u0000`;
    })
    .replace(/`[^`\n]+`/g, (m) => {
      codeSpans.push(m);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
  const wrapped = protectedText.replace(FILE_REF_PREPROCESS_RE, (match, g1, g2, g3, g4) => {
    if (g1) return `**Source: [${g1}](<${g1}>)**`;
    if (g2) return `**[${g2}](<${g2}>)**`;
    if (g3) return `*Source: [${g3}](<${g3}>)*`;
    if (g4) return `[Source: [${g4}](<${g4}>)]`;
    return `[${match}](<${match}>)`;
  });
  return wrapped.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] ?? "");
}

function isFileRef(href: string): boolean {
  if (!href || LOCAL_HOST_RE.test(href)) return false;
  // Must look like a filename: word.ext or word.word.ext (no query strings, no
  // fragments). If it starts with http:// it was linkified from a bare
  // filename — strip the protocol before testing so `http://a.md` and `a.md`
  // are treated identically.
  const stripped = href.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (stripped.includes("?") || stripped.includes("#")) return false;
  // Real URLs have a path separator. The only slash-bearing hrefs that are
  // file refs are the preprocessor's `raw_sources/` links (linkify-created
  // hostless filenames never contain a slash).
  if (stripped.includes("/") && !stripped.startsWith("raw_sources/")) return false;
  let decoded = stripped;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    // Fall back to the raw href when it is not valid percent-encoding.
  }
  const lastSegment = decoded.split("/").pop() ?? "";
  return /^[\w.% '’()—–-]+$/.test(lastSegment) && /\.(?:[a-zA-Z0-9]{1,5})$/.test(lastSegment);
}

function extractFileName(href: string): string {
  const stripped = href.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const lastSegment = stripped.split("/").pop() ?? "";
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  if (!token) return self.renderToken(tokens, idx, options);
  const href = token.attrGet("href");
  if (!href) return self.renderToken(tokens, idx, options);

  if (isFileRef(href)) {
    const fileName = extractFileName(href);
    return `<span class="file-ref" data-file-link="${md.utils.escapeHtml(fileName)}" role="button" tabindex="0">`;
  }

  if (!href.startsWith("/") && !href.startsWith("#") && !href.startsWith("mailto:")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_close = (tokens, idx, options, _env, self) => {
  let openIdx = idx - 1;
  while (openIdx >= 0 && tokens[openIdx]?.type !== "link_open") openIdx--;
  const openToken = tokens[openIdx];
  if (openToken) {
    const href = openToken.attrGet("href");
    if (href && isFileRef(href)) {
      return "</span>";
    }
  }
  return self.renderToken(tokens, idx, options);
};

// Configure DOMPurify to allow code blocks and syntax highlighting
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    // Standard HTML
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "a", "strong", "em", "code", "pre",
    "ul", "ol", "li",
    "blockquote", "table", "thead", "tbody", "tr", "th", "td",
    "img", "del", "sup", "sub",
    // highlight.js wrapper
    "span",
  ],
  ALLOWED_ATTR: ["href", "target", "rel", "class", "id", "alt", "src", "title", "data-file-link", "role", "tabindex"],
};

export function renderMarkdown(text: string): string {
  try {
    const html = md.render(preprocessBareFileRefs(text));
    return DOMPurify.sanitize(html, PURIFY_CONFIG);
  } catch {
    // DOMPurify v3.4.13 _parseConfig can throw on undefined config values.
    // Fall back to raw HTML — markdown-it already escapes HTML (html: false).
    return md.render(text);
  }
}