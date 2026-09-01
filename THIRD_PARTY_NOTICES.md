# Third-Party Notices

This file acknowledges third-party projects whose **ideas, designs, or
software** are referenced or redistributed by Simmetric Chat. It is maintained for
attribution and license-compliance purposes.

> **Scope note.** Simmetric Chat is an independent work. Where a feature is
> "inspired by" an upstream project, the design pattern or concept was
> studied and **reimplemented from scratch** in this codebase; no source code
> was copied unless explicitly stated below (and only from permissively
> licensed material). Dependencies pulled via the package manager carry their
> own license files inside `node_modules/<pkg>/LICENSE`, which are preserved
> by the toolchain and not redistributed in source form here.

---

## Open WebUI — `open-webui/open-webui`

- **Project:** https://github.com/open-webui/open-webui
- **Copyright:** © 2023– Open WebUI Inc. (created by Timothy Jaeryang Baek)
- **Current license:** "Open WebUI License" — a BSD-style license with an
  additional branding clause (clause 4). See
  https://github.com/open-webui/open-webui/blob/main/LICENSE
- **Historical licenses:** code created before commit `60d84a3aae` was
  governed by BSD 3-Clause; code created before commit `a76068d69cd` was
  governed by the MIT License. See
  https://github.com/open-webui/open-webui/blob/main/LICENSE_HISTORY

**How Simmetric Chat uses it:** The per-user memory feature (Phase 97) is
**inspired by** open-webui's memory design — the "review memory after a
turn" pattern and the 4-operation memory protocol (add / replace / move /
remove). The extraction prompt, the validation gate, the sensitivity
classification, the DLP / agent-instruction deny-list, the dedup-rewrite
logic, and the path-ranking helper are **independent reimplementations**
written for Simmetric Chat; they are not derived from open-webui source code.

The chat-import service (`parseOpenWebUI`) reads open-webui's **export file
format** for interoperability (importing a user's own exported conversations).
No open-webui source code is reproduced; only the JSON shape of the export is
parsed, which is an uncopyrightable interface.

The "Open WebUI" name appears in the chat-import dialog solely to identify the
supported import format — nominative use for interoperability, not an
endorsement or affiliation. No Open WebUI logo, branding, or claim of
affiliation is used by Simmetric Chat.

---

## Mintplex Labs — npm packages

- `@mintplex-labs/bree` — job scheduler (backups, MCP health-checks, OCR jobs).

This package is used as a runtime dependency under the MIT License and
carries its own `LICENSE` file inside `node_modules/<pkg>/LICENSE`. No Mintplex
Labs application source code is derived by Simmetric Chat.

MIT License notice (retained verbatim per its terms):

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

---

## Dependency Licenses

The table below is auto-generated from `pnpm licenses list --prod` and lists
every production dependency of the pnpm workspace. Regenerate it with
`node scripts/generate-notices.cjs`; the CI `license-policy-check` job
drift-gates the committed copy so a stale notices file fails the build.

<!-- BEGIN AUTO-GENERATED — do not edit below this line, run `node scripts/generate-notices.cjs` -->
| License | Package | Version(s) | Homepage |
|---------|---------|------------|----------|
| (MIT AND Zlib) | pako | 1.0.11 | https://github.com/nodeca/pako |
| (MIT OR CC0-1.0) | type-fest | 0.13.1, 5.9.0 | https://github.com/sindresorhus/type-fest#readme |
| (MIT OR GPL-3.0-or-later) | jszip | 3.10.1 | https://github.com/Stuk/jszip#readme |
| (MPL-2.0 OR Apache-2.0) | dompurify | 3.4.14 | https://github.com/cure53/DOMPurify |
| 0BSD | tslib | 2.8.1 | https://www.typescriptlang.org/ |
| Apache-2.0 | @electric-sql/pglite | 0.4.3 | https://pglite.dev |
| Apache-2.0 | @electric-sql/pglite-socket | 0.1.3 | https://pglite.dev |
| Apache-2.0 | @electric-sql/pglite-tools | 0.3.3 | https://pglite.dev |
| Apache-2.0 | @huggingface/tokenizers | 0.1.3 | https://github.com/huggingface/tokenizers.js#readme |
| Apache-2.0 | @huggingface/transformers | 3.0.2, 4.2.0 | https://github.com/huggingface/transformers.js#readme |
| Apache-2.0 | @img/sharp-linux-x64 | 0.33.5, 0.34.5, 0.35.4 | https://sharp.pixelplumbing.com |
| Apache-2.0 | @lancedb/lancedb | 0.31.0 | https://github.com/lancedb/lancedb#readme |
| Apache-2.0 | @lancedb/lancedb-linux-x64-gnu | 0.31.0 | https://github.com/lancedb/lancedb#readme |
| Apache-2.0 | @mozilla/readability | 0.6.0 | https://github.com/mozilla/readability |
| Apache-2.0 | @prisma/adapter-pg | 7.10.0 | https://github.com/prisma/prisma#readme |
| Apache-2.0 | @prisma/client | 7.10.0 | https://www.prisma.io |
| Apache-2.0 | @prisma/client-runtime-utils | 7.10.0 | https://github.com/prisma/prisma#readme |
| Apache-2.0 | @prisma/config | 7.10.0 | https://github.com/prisma/prisma#readme |
| Apache-2.0 | @prisma/debug | 7.2.0, 7.10.0 | https://www.prisma.io |
| Apache-2.0 | @prisma/driver-adapter-utils | 7.10.0 | https://github.com/prisma/prisma#readme |
| Apache-2.0 | @prisma/engines | 7.10.0 | https://github.com/prisma/prisma#readme |
| Apache-2.0 | @prisma/engines-version | 7.10.0-4.0edf323efd1d98336f3f0a68684b56f689b900d3 | https://github.com/prisma/engines-wrapper#readme |
| Apache-2.0 | @prisma/fetch-engine | 7.10.0 | https://www.prisma.io |
| Apache-2.0 | @prisma/get-platform | 7.2.0, 7.10.0 | https://www.prisma.io |
| Apache-2.0 | @prisma/query-plan-executor | 7.2.0 | https://github.com/prisma/prisma#readme |
| Apache-2.0 | @prisma/streams-local | 0.1.11 | https://github.com/prisma/streams/tree/main/docs |
| Apache-2.0 | @prisma/studio-core | 0.33.0 | https://github.com/prisma/studio#readme |
| Apache-2.0 | @puppeteer/browsers | 3.2.1 | https://github.com/puppeteer/puppeteer/tree/main#readme |
| Apache-2.0 | @scarf/scarf | 1.4.0 | https://github.com/scarf-sh/scarf-js |
| Apache-2.0 | @swc/helpers | 0.5.23 | https://swc.rs |
| Apache-2.0 | @xenova/transformers | 2.17.2 | https://github.com/xenova/transformers.js#readme |
| Apache-2.0 | adler-32 | 1.3.1 | http://sheetjs.com/opensource |
| Apache-2.0 | apache-arrow | 18.1.0 | https://github.com/apache/arrow/blob/main/js/README.md |
| Apache-2.0 | b4a | 1.8.1 | https://github.com/holepunchto/b4a#readme |
| Apache-2.0 | bare-events | 2.9.2 | https://github.com/holepunchto/bare-events#readme |
| Apache-2.0 | bare-fs | 4.8.1 | https://github.com/holepunchto/bare-fs#readme |
| Apache-2.0 | bare-path | 3.1.1 | https://github.com/holepunchto/bare-path#readme |
| Apache-2.0 | bare-stream | 2.13.4 | https://github.com/holepunchto/bare-stream#readme |
| Apache-2.0 | bare-url | 2.5.2 | https://github.com/holepunchto/bare-url |
| Apache-2.0 | cfb | 1.2.2 | http://sheetjs.com/ |
| Apache-2.0 | chromadb | 3.5.0 | — |
| Apache-2.0 | chromium-bidi | 17.0.2 | https://github.com/GoogleChromeLabs/chromium-bidi#readme |
| Apache-2.0 | class-variance-authority | 0.7.1 | https://github.com/joe-bell/cva#readme |
| Apache-2.0 | cluster-key-slot | 1.1.1 | https://github.com/Salakar/cluster-key-slot#readme |
| Apache-2.0 | codepage | 1.15.0 | https://sheetjs.com/ |
| Apache-2.0 | crc-32 | 1.2.2 | https://sheetjs.com/ |
| Apache-2.0 | denque | 2.1.0 | https://docs.page/invertase/denque |
| Apache-2.0 | detect-libc | 2.1.2 | https://github.com/lovell/detect-libc#readme |
| Apache-2.0 | diff-match-patch | 1.0.5 | https://github.com/JackuB/diff-match-patch#readme |
| Apache-2.0 | doctrine | 3.0.0 | https://github.com/eslint/doctrine |
| Apache-2.0 | ecdsa-sig-formatter | 1.0.11 | https://github.com/Brightspace/node-ecdsa-sig-formatter#readme |
| Apache-2.0 | events-universal | 1.0.1 | https://github.com/holepunchto/events-universal#readme |
| Apache-2.0 | flatbuffers | 24.12.23, 25.9.23 | https://google.github.io/flatbuffers/ |
| Apache-2.0 | frac | 1.1.2 | http://sheetjs.com/opensource |
| Apache-2.0 | idb-keyval | 6.3.0 | https://github.com/jakearchibald/idb-keyval#readme |
| Apache-2.0 | long | 4.0.0, 5.3.2 | https://github.com/dcodeIO/long.js#readme |
| Apache-2.0 | openai | 4.29.2 | https://github.com/openai/openai-node#readme |
| Apache-2.0 | pdfjs-dist | 6.1.200, 6.3.289 | https://mozilla.github.io/pdf.js/ |
| Apache-2.0 | prisma | 7.10.0 | https://www.prisma.io |
| Apache-2.0 | puppeteer | 25.9.0 | https://github.com/puppeteer/puppeteer/tree/main#readme |
| Apache-2.0 | puppeteer-core | 25.9.0 | https://github.com/puppeteer/puppeteer/tree/main#readme |
| Apache-2.0 | readdir-glob | 3.0.0 | https://github.com/Yqnn/node-readdir-glob |
| Apache-2.0 | reflect-metadata | 0.2.2 | http://rbuckton.github.io/reflect-metadata |
| Apache-2.0 | sharp | 0.33.5, 0.34.5, 0.35.4 | https://sharp.pixelplumbing.com |
| Apache-2.0 | ssf | 0.11.2 | http://sheetjs.com/ |
| Apache-2.0 | swagger-ui-dist | 5.32.14 | https://github.com/swagger-api/swagger-ui#readme |
| Apache-2.0 | tesseract.js | 7.0.0 | https://github.com/naptha/tesseract.js |
| Apache-2.0 | tesseract.js-core | 7.0.0 | https://github.com/naptha/tesseract.js-core |
| Apache-2.0 | text-decoder | 1.2.7 | https://github.com/holepunchto/text-decoder#readme |
| Apache-2.0 | typescript | 6.0.3 | https://www.typescriptlang.org/ |
| Apache-2.0 | wasm-feature-detect | 1.9.0 | https://github.com/GoogleChromeLabs/wasm-feature-detect#readme |
| Apache-2.0 | webdriver-bidi-protocol | 0.4.2 | https://github.com/GoogleChromeLabs/webdriver-bidi-protocol#readme |
| Apache-2.0 | wmf | 1.0.2 | https://sheetjs.com/ |
| Apache-2.0 | word | 0.3.0 | https://wordjs.com/ |
| Apache-2.0 | xlsx | 0.18.5 | https://sheetjs.com/ |
| Apache-2.0 | xml-name-validator | 5.0.0 | https://github.com/jsdom/xml-name-validator#readme |
| BlueOak-1.0.0 | @isaacs/cliui | 9.0.0 | https://github.com/isaacs/cliui#readme |
| BlueOak-1.0.0 | chownr | 3.0.0 | https://github.com/isaacs/chownr#readme |
| BlueOak-1.0.0 | glob | 11.1.0 | https://github.com/isaacs/node-glob#readme |
| BlueOak-1.0.0 | jackspeak | 4.2.3 | https://github.com/isaacs/jackspeak#readme |
| BlueOak-1.0.0 | lru-cache | 11.5.2 | https://github.com/isaacs/node-lru-cache#readme |
| BlueOak-1.0.0 | minimatch | 10.2.6 | https://github.com/isaacs/minimatch#readme |
| BlueOak-1.0.0 | minipass | 7.1.3 | https://github.com/isaacs/minipass#readme |
| BlueOak-1.0.0 | package-json-from-dist | 1.0.1 | https://github.com/isaacs/package-json-from-dist#readme |
| BlueOak-1.0.0 | path-scurry | 2.0.2 | https://github.com/isaacs/path-scurry#readme |
| BlueOak-1.0.0 | tar | 7.5.22 | https://github.com/isaacs/node-tar#readme |
| BlueOak-1.0.0 | yallist | 5.0.0 | https://github.com/isaacs/yallist#readme |
| BSD | duck | 0.1.12 | https://github.com/mwilliamson/duck.js#readme |
| BSD-2-Clause | @mixmark-io/domino | 2.2.0 | https://github.com/mixmark-io/domino#readme |
| BSD-2-Clause | dingbat-to-unicode | 1.0.1 | https://github.com/mwilliamson/dingbat-to-unicode#readme |
| BSD-2-Clause | dotenv | 17.4.2 | https://github.com/motdotla/dotenv#readme |
| BSD-2-Clause | entities | 4.5.0, 8.0.0 | https://github.com/fb55/entities#readme |
| BSD-2-Clause | esprima | 4.0.1 | http://esprima.org |
| BSD-2-Clause | esutils | 2.0.3 | https://github.com/estools/esutils |
| BSD-2-Clause | json-schema-typed | 8.0.2 | https://github.com/RemyRylan/json-schema-typed/tree/main/dist/node |
| BSD-2-Clause | lop | 0.4.2 | https://github.com/mwilliamson/lop#readme |
| BSD-2-Clause | mammoth | 1.12.2 | https://github.com/mwilliamson/mammoth.js#readme |
| BSD-2-Clause | option | 0.2.4 | https://github.com/mwilliamson/node-options#readme |
| BSD-2-Clause | webidl-conversions | 3.0.1, 8.0.1 | https://github.com/jsdom/webidl-conversions#readme |
| BSD-3-Clause | @protobufjs/aspromise | 1.1.2 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/base64 | 1.1.2 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/codegen | 2.0.5 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/eventemitter | 1.1.1 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/fetch | 1.1.1 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/float | 1.0.2 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/inquire | 1.1.2 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/path | 1.1.2 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/pool | 1.1.0 | https://github.com/dcodeIO/protobuf.js#readme |
| BSD-3-Clause | @protobufjs/utf8 | 1.1.2 | https://github.com/protobufjs/protobuf.js#readme |
| BSD-3-Clause | bcryptjs | 3.0.3 | https://github.com/dcodeIO/bcrypt.js#readme |
| BSD-3-Clause | buffer-equal-constant-time | 1.0.1 | https://github.com/goinstant/buffer-equal-constant-time#readme |
| BSD-3-Clause | charenc | 0.0.2 | https://github.com/pvorb/node-charenc#readme |
| BSD-3-Clause | crypt | 0.0.2 | https://github.com/pvorb/node-crypt#readme |
| BSD-3-Clause | d3-ease | 3.0.1 | https://d3js.org/d3-ease/ |
| BSD-3-Clause | deepmerge-ts | 7.1.5 | https://github.com/RebeccaStevens/deepmerge-ts#readme |
| BSD-3-Clause | devtools-protocol | 0.0.1666840 | https://github.com/ChromeDevTools/devtools-protocol#readme |
| BSD-3-Clause | fast-uri | 3.1.6 | https://github.com/fastify/fast-uri |
| BSD-3-Clause | global-agent | 3.0.0 | https://github.com/gajus/global-agent#readme |
| BSD-3-Clause | highlight.js | 11.12.0 | https://highlightjs.org/ |
| BSD-3-Clause | ieee754 | 1.2.1 | https://github.com/feross/ieee754#readme |
| BSD-3-Clause | md5 | 2.3.0 | https://github.com/pvorb/node-md5#readme |
| BSD-3-Clause | protobufjs | 6.11.6, 7.6.6 | https://protobufjs.github.io/protobuf.js/ |
| BSD-3-Clause | qs | 6.16.0 | https://github.com/ljharb/qs |
| BSD-3-Clause | roarr | 2.15.4 | https://github.com/gajus/roarr#readme |
| BSD-3-Clause | rw | 1.3.3 | https://github.com/mbostock/rw |
| BSD-3-Clause | source-map-js | 1.2.1 | https://github.com/7rulnik/source-map-js |
| BSD-3-Clause | sprintf-js | 1.0.3, 1.1.3 | https://github.com/alexei/sprintf.js#readme |
| BSD-3-Clause | tough-cookie | 6.0.2 | https://github.com/salesforce/tough-cookie |
| CC0-1.0 | mdn-data | 2.27.1 | https://developer.mozilla.org |
| EPL-2.0 | elkjs | 0.11.1 | https://github.com/kieler/elkjs#readme |
| ISC | @isaacs/fs-minipass | 4.0.1 | https://github.com/npm/fs-minipass#readme |
| ISC | @prisma/dev | 0.24.17 | — |
| ISC | cliui | 9.0.1 | https://github.com/yargs/cliui#readme |
| ISC | d3 | 7.9.0 | https://d3js.org |
| ISC | d3-array | 3.2.1, 3.2.4 | https://d3js.org/d3-array/ |
| ISC | d3-axis | 3.0.0 | https://d3js.org/d3-axis/ |
| ISC | d3-brush | 3.0.0 | https://d3js.org/d3-brush/ |
| ISC | d3-chord | 3.0.1 | https://d3js.org/d3-chord/ |
| ISC | d3-color | 3.1.0 | https://d3js.org/d3-color/ |
| ISC | d3-contour | 4.0.2 | https://d3js.org/d3-contour/ |
| ISC | d3-delaunay | 6.0.2, 6.0.4 | https://github.com/d3/d3-delaunay |
| ISC | d3-dispatch | 3.0.1 | https://d3js.org/d3-dispatch/ |
| ISC | d3-drag | 3.0.0 | https://d3js.org/d3-drag/ |
| ISC | d3-dsv | 3.0.1 | https://d3js.org/d3-dsv/ |
| ISC | d3-fetch | 3.0.1 | https://d3js.org/d3-fetch/ |
| ISC | d3-force | 3.0.0 | https://d3js.org/d3-force/ |
| ISC | d3-format | 3.1.0, 3.1.2 | https://d3js.org/d3-format/ |
| ISC | d3-geo | 3.1.0, 3.1.1 | https://d3js.org/d3-geo/ |
| ISC | d3-hierarchy | 3.1.2 | https://d3js.org/d3-hierarchy/ |
| ISC | d3-interpolate | 3.0.1 | https://d3js.org/d3-interpolate/ |
| ISC | d3-path | 3.1.0 | https://d3js.org/d3-path/ |
| ISC | d3-polygon | 3.0.1 | https://d3js.org/d3-polygon/ |
| ISC | d3-quadtree | 3.0.1 | https://d3js.org/d3-quadtree/ |
| ISC | d3-random | 3.0.1 | https://d3js.org/d3-random/ |
| ISC | d3-scale | 4.0.2 | https://d3js.org/d3-scale/ |
| ISC | d3-scale-chromatic | 3.1.0 | https://d3js.org/d3-scale-chromatic/ |
| ISC | d3-selection | 3.0.0 | https://d3js.org/d3-selection/ |
| ISC | d3-shape | 3.2.0 | https://d3js.org/d3-shape/ |
| ISC | d3-time | 3.1.0 | https://d3js.org/d3-time/ |
| ISC | d3-time-format | 4.1.0 | https://d3js.org/d3-time-format/ |
| ISC | d3-timer | 3.0.1 | https://d3js.org/d3-timer/ |
| ISC | d3-transition | 3.0.1 | https://d3js.org/d3-transition/ |
| ISC | d3-zoom | 3.0.0 | https://d3js.org/d3-zoom/ |
| ISC | delaunator | 5.1.0 | https://github.com/mapbox/delaunator#readme |
| ISC | digest-fetch | 1.3.0 | https://github.com/devfans/digest-fetch#readme |
| ISC | foreground-child | 3.3.1 | https://github.com/tapjs/foreground-child#readme |
| ISC | get-caller-file | 2.0.5 | https://github.com/stefanpenner/get-caller-file#readme |
| ISC | graceful-fs | 4.2.11 | https://github.com/isaacs/node-graceful-fs#readme |
| ISC | guid-typescript | 1.0.9 | https://github.com/NicolasDeveloper/guid-typescript#readme |
| ISC | inherits | 2.0.4 | https://github.com/isaacs/inherits#readme |
| ISC | internmap | 2.0.3 | https://github.com/mbostock/internmap/ |
| ISC | isexe | 2.0.0 | https://github.com/isaacs/isexe#readme |
| ISC | json-stringify-safe | 5.0.1 | https://github.com/isaacs/json-stringify-safe |
| ISC | jsonrepair | 3.15.0 | https://github.com/josdejong/jsonrepair#readme |
| ISC | lucide-react | 1.38.0 | https://lucide.dev |
| ISC | minimalistic-assert | 1.0.1 | https://github.com/calvinmetcalf/minimalistic-assert |
| ISC | once | 1.4.0 | https://github.com/isaacs/once#readme |
| ISC | pg-int8 | 1.0.1 | https://github.com/charmander/pg-int8#readme |
| ISC | saxes | 6.0.0 | https://github.com/lddubeau/saxes#readme |
| ISC | semver | 7.8.5 | https://github.com/npm/node-semver#readme |
| ISC | setprototypeof | 1.2.0 | https://github.com/wesleytodd/setprototypeof |
| ISC | signal-exit | 3.0.7, 4.1.0 | https://github.com/tapjs/signal-exit#readme |
| ISC | split2 | 4.2.0 | https://github.com/mcollina/split2#readme |
| ISC | which | 2.0.2 | https://github.com/isaacs/node-which#readme |
| ISC | wrappy | 1.0.2 | https://github.com/npm/wrappy |
| ISC | y18n | 5.0.8 | https://github.com/yargs/y18n |
| ISC | yaml | 2.0.0-1 | https://eemeli.org/yaml/ |
| ISC | yargs-parser | 22.0.0 | https://github.com/yargs/yargs-parser#readme |
| ISC | zod-to-json-schema | 3.25.2 | https://github.com/StefanTerdell/zod-to-json-schema#readme |
| LGPL-3.0-or-later | @img/sharp-libvips-linux-x64 | 1.0.4, 1.2.4, 1.3.3 | https://sharp.pixelplumbing.com |
| MIT | @apidevtools/json-schema-ref-parser | 14.0.1 | https://apidevtools.com/json-schema-ref-parser/ |
| MIT | @apidevtools/openapi-schemas | 2.1.0 | https://apitools.dev/openapi-schemas |
| MIT | @apidevtools/swagger-methods | 3.0.2 | https://github.com/APIDevTools/swagger-methods |
| MIT | @apidevtools/swagger-parser | 12.1.0 | https://apidevtools.com/swagger-parser/ |
| MIT | @asamuzakjp/css-color | 5.1.11 | https://github.com/asamuzaK/cssColor#readme |
| MIT | @asamuzakjp/dom-selector | 7.1.1 | https://github.com/asamuzaK/domSelector#readme |
| MIT | @asamuzakjp/generational-cache | 1.0.1 | https://github.com/asamuzaK/generationalCache |
| MIT | @asamuzakjp/nwsapi | 2.3.9 | http://javascript.nwbox.com/nwsapi/ |
| MIT | @babel/runtime | 7.29.7 | https://babel.dev/docs/en/next/babel-runtime |
| MIT | @borewit/text-codec | 0.2.2 | https://github.com/Borewit/text-codec#readme |
| MIT | @bramus/specificity | 2.4.2 | https://github.com/bramus/specificity#readme |
| MIT | @cfworker/json-schema | 4.1.1 | https://github.com/cfworker/cfworker/tree/master/packages/json-schema/README.md |
| MIT | @colors/colors | 1.6.0 | https://github.com/DABH/colors.js |
| MIT | @csstools/css-calc | 3.3.0 | https://github.com/csstools/postcss-plugins/tree/main/packages/css-calc#readme |
| MIT | @csstools/css-color-parser | 4.2.2 | https://github.com/csstools/postcss-plugins/tree/main/packages/css-color-parser#readme |
| MIT | @csstools/css-parser-algorithms | 4.0.0 | https://github.com/csstools/postcss-plugins/tree/main/packages/css-parser-algorithms#readme |
| MIT | @csstools/css-tokenizer | 4.0.0 | https://github.com/csstools/postcss-plugins/tree/main/packages/css-tokenizer#readme |
| MIT | @dabh/diagnostics | 2.0.8 | https://github.com/DABH/diagnostics |
| MIT | @dnd-kit/accessibility | 3.1.1 | https://github.com/clauderic/dnd-kit#readme |
| MIT | @dnd-kit/core | 6.3.1 | https://github.com/clauderic/dnd-kit#readme |
| MIT | @dnd-kit/utilities | 3.2.2 | https://github.com/clauderic/dnd-kit#readme |
| MIT | @esbuild/linux-x64 | 0.28.2 | https://github.com/evanw/esbuild#readme |
| MIT | @exodus/bytes | 1.15.1 | https://github.com/ExodusOSS/bytes |
| MIT | @floating-ui/core | 1.8.0 | https://floating-ui.com |
| MIT | @floating-ui/dom | 1.8.0 | https://floating-ui.com |
| MIT | @floating-ui/react-dom | 2.1.9 | https://floating-ui.com/docs/react-dom |
| MIT | @floating-ui/utils | 0.2.12 | https://floating-ui.com |
| MIT | @hono/node-server | 2.1.1 | https://github.com/honojs/node-server |
| MIT | @hookform/resolvers | 5.9.1 | https://react-hook-form.com |
| MIT | @huggingface/jinja | 0.2.2, 0.3.4, 0.5.9 | https://github.com/huggingface/huggingface.js#readme |
| MIT | @img/colour | 1.1.0 | https://github.com/lovell/colour#readme |
| MIT | @ioredis/commands | 1.10.0 | https://github.com/ioredis/commands |
| MIT | @json2csv/formatters | 7.0.8 | https://juanjodiaz.github.io/json2csv |
| MIT | @json2csv/plainjs | 7.0.8 | https://juanjodiaz.github.io/json2csv |
| MIT | @kwsites/file-exists | 1.1.1 | https://github.com/kwsites/file-exists#readme |
| MIT | @kwsites/promise-deferred | 1.1.1 | https://github.com/kwsites/promise-deferred#readme |
| MIT | @langchain/core | 1.2.9 | https://github.com/langchain-ai/langchainjs/tree/main/langchain-core/ |
| MIT | @langchain/textsplitters | 1.0.1 | https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-textsplitters/ |
| MIT | @microsoft/fetch-event-source | 2.0.1 | https://github.com/Azure/fetch-event-source#readme |
| MIT | @modelcontextprotocol/sdk | 1.30.0 | https://modelcontextprotocol.io |
| MIT | @napi-rs/canvas | 1.0.8 | https://github.com/Brooooooklyn/canvas#readme |
| MIT | @napi-rs/canvas-linux-x64-gnu | 1.0.8 | https://github.com/Brooooooklyn/canvas#readme |
| MIT | @noble/hashes | 1.8.0 | https://paulmillr.com/noble/ |
| MIT | @radix-ui/number | 1.1.3 | https://radix-ui.com/primitives |
| MIT | @radix-ui/primitive | 1.1.3, 1.1.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-accessible-icon | 1.1.15 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-accordion | 1.2.20 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-alert-dialog | 1.1.23 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-arrow | 1.1.15 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-aspect-ratio | 1.1.15 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-avatar | 1.2.6 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-checkbox | 1.3.11 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-collapsible | 1.1.20 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-collection | 1.1.15 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-compose-refs | 1.1.2, 1.1.5 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-context | 1.2.2 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-context-menu | 2.3.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-dialog | 1.1.23 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-direction | 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-dismissable-layer | 1.1.19 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-dropdown-menu | 2.1.24 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-focus-guards | 1.1.6 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-focus-scope | 1.1.16 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-form | 0.1.16 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-hover-card | 1.1.23 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-id | 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-label | 2.1.15 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-menu | 2.1.24 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-menubar | 1.1.24 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-navigation-menu | 1.2.22 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-one-time-password-field | 0.1.16 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-password-toggle-field | 0.1.11 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-popover | 1.1.23 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-popper | 1.3.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-portal | 1.1.17 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-presence | 1.1.10 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-primitive | 2.1.3, 2.1.10 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-progress | 1.1.16 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-radio-group | 1.4.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-roving-focus | 1.1.19 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-scroll-area | 1.2.18 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-select | 2.3.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-separator | 1.1.15 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-slider | 1.4.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-slot | 1.2.3, 1.3.3 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-switch | 1.3.7 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-tabs | 1.1.21 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-toast | 1.2.23 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-toggle | 1.1.10, 1.1.18 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-toggle-group | 1.1.19 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-toolbar | 1.1.19 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-tooltip | 1.2.16 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-callback-ref | 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-controllable-state | 1.2.2, 1.2.6 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-effect-event | 0.0.2, 0.0.5 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-escape-keydown | 1.1.5 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-is-hydrated | 0.1.3 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-layout-effect | 1.1.1, 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-previous | 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-rect | 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-use-size | 1.1.4 | https://radix-ui.com/primitives |
| MIT | @radix-ui/react-visually-hidden | 1.2.11 | https://radix-ui.com/primitives |
| MIT | @radix-ui/rect | 1.1.3 | https://radix-ui.com/primitives |
| MIT | @reduxjs/toolkit | 2.12.0 | https://redux-toolkit.js.org |
| MIT | @simple-git/args-pathspec | 1.0.3 | https://github.com/steveukx/git-js#readme |
| MIT | @simple-git/argv-parser | 1.1.1 | https://github.com/steveukx/git-js#readme |
| MIT | @sinclair/typebox | 0.34.52 | https://github.com/sinclairzx81/sinclair-typebox#readme |
| MIT | @so-ric/colorspace | 1.1.6 | https://github.com/so-ric/colorspace |
| MIT | @standard-schema/spec | 1.1.0 | https://standardschema.dev |
| MIT | @standard-schema/utils | 0.3.0 | https://github.com/standard-schema/standard-schema#readme |
| MIT | @streamparser/json | 0.0.23 | https://github.com/juanjoDiaz/jsonparse2#readme |
| MIT | @tailwindcss/typography | 0.5.20 | https://github.com/tailwindlabs/tailwindcss-typography#readme |
| MIT | @tanstack/query-core | 5.102.8 | https://tanstack.com/query |
| MIT | @tanstack/react-query | 5.102.8 | https://tanstack.com/query |
| MIT | @tavily/core | 0.7.8 | https://tavily.com |
| MIT | @tokenizer/inflate | 0.4.1 | https://github.com/Borewit/tokenizer-inflate#readme |
| MIT | @tokenizer/token | 0.3.0 | https://github.com/Borewit/tokenizer-token#readme |
| MIT | @types/command-line-args | 5.2.3 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/command-line-args |
| MIT | @types/command-line-usage | 5.0.4 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/command-line-usage |
| MIT | @types/d3-array | 3.0.3, 3.2.2 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-array |
| MIT | @types/d3-color | 3.1.0, 3.1.3 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-color |
| MIT | @types/d3-delaunay | 6.0.1 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-delaunay |
| MIT | @types/d3-ease | 3.0.2 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-ease |
| MIT | @types/d3-format | 3.0.1 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-format |
| MIT | @types/d3-geo | 3.1.0 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-geo |
| MIT | @types/d3-interpolate | 3.0.1, 3.0.4 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-interpolate |
| MIT | @types/d3-path | 3.1.1 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-path |
| MIT | @types/d3-scale | 4.0.2, 4.0.9 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-scale |
| MIT | @types/d3-shape | 3.1.7, 3.2.0 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-shape |
| MIT | @types/d3-time | 3.0.0, 3.0.4 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-time |
| MIT | @types/d3-time-format | 2.1.0 | https://github.com/DefinitelyTyped/DefinitelyTyped#readme |
| MIT | @types/d3-timer | 3.0.2 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-timer |
| MIT | @types/geojson | 7946.0.16 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/geojson |
| MIT | @types/json-schema | 7.0.15 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/json-schema |
| MIT | @types/lodash | 4.17.25 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/lodash |
| MIT | @types/long | 4.0.2 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/long |
| MIT | @types/node | 18.19.130, 20.19.43, 26.4.0 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node |
| MIT | @types/node-fetch | 2.6.13 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node-fetch |
| MIT | @types/pg | 8.23.1 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pg |
| MIT | @types/react | 19.2.18 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react |
| MIT | @types/react-dom | 19.2.5 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/react-dom |
| MIT | @types/triple-beam | 1.3.5 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/triple-beam |
| MIT | @types/trusted-types | 2.0.7 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/trusted-types |
| MIT | @types/use-sync-external-store | 0.0.6 | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/use-sync-external-store |
| MIT | @visx/curve | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/event | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/grid | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/group | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/point | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/responsive | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/scale | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @visx/shape | 4.0.1-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT | @xmldom/xmldom | 0.8.15, 0.9.12 | https://github.com/xmldom/xmldom |
| MIT | abort-controller | 3.0.0 | https://github.com/mysticatea/abort-controller#readme |
| MIT | accepts | 2.0.0 | https://github.com/jshttp/accepts#readme |
| MIT | adm-zip | 0.5.18 | https://github.com/cthackers/adm-zip |
| MIT | agent-base | 6.0.2, 7.1.4 | https://github.com/TooTallNate/proxy-agents#readme |
| MIT | agentkeepalive | 4.6.0 | https://github.com/node-modules/agentkeepalive#readme |
| MIT | ajv | 8.20.0 | https://ajv.js.org |
| MIT | ajv-draft-04 | 1.0.0 | https://github.com/ajv-validator/ajv-draft-04#readme |
| MIT | ajv-formats | 2.1.1, 3.0.1 | https://github.com/ajv-validator/ajv-formats#readme |
| MIT | ansi-regex | 6.3.0 | https://github.com/chalk/ansi-regex#readme |
| MIT | ansi-styles | 4.3.0, 6.2.3 | https://github.com/chalk/ansi-styles#readme |
| MIT | append-field | 1.0.0 | https://github.com/LinusU/node-append-field#readme |
| MIT | archiver | 8.0.0 | https://github.com/archiverjs/node-archiver |
| MIT | argparse | 1.0.10 | https://github.com/nodeca/argparse#readme |
| MIT | aria-hidden | 1.2.6 | https://github.com/theKashey/aria-hidden#readme |
| MIT | array-back | 3.1.0, 6.2.3 | https://github.com/75lb/array-back#readme |
| MIT | asn1.js | 5.4.1 | https://github.com/indutny/asn1.js |
| MIT | async | 3.2.6 | https://caolan.github.io/async/ |
| MIT | asynckit | 0.4.0 | https://github.com/alexindigo/asynckit#readme |
| MIT | attr-accept | 2.2.5 | https://github.com/react-dropzone/attr-accept#readme |
| MIT | aws-ssl-profiles | 1.1.2 | https://github.com/mysqljs/aws-ssl-profiles#readme |
| MIT | axios | 1.20.0 | https://axios-http.com |
| MIT | balanced-match | 4.0.4 | https://github.com/juliangruber/balanced-match#readme |
| MIT | base-64 | 0.1.0 | http://mths.be/base64 |
| MIT | base64-js | 1.5.1 | https://github.com/beatgammit/base64-js |
| MIT | better-result | 2.10.0 | https://better-result.dev |
| MIT | bidi-js | 1.0.3 | https://github.com/lojjic/bidi-js#readme |
| MIT | bluebird | 3.4.7 | https://github.com/petkaantonov/bluebird |
| MIT | bmp-js | 0.1.0 | https://github.com/shaozilee/bmp-js#readme |
| MIT | bn.js | 4.12.5 | https://github.com/indutny/bn.js |
| MIT | body-parser | 2.3.0 | https://github.com/expressjs/body-parser#readme |
| MIT | boolean | 3.2.0 | https://github.com/thenativeweb/boolean#readme |
| MIT | brace-expansion | 5.0.9 | https://github.com/juliangruber/brace-expansion#readme |
| MIT | buffer | 6.0.3 | https://github.com/feross/buffer |
| MIT | buffer-crc32 | 1.0.0 | https://github.com/brianloveswords/buffer-crc32 |
| MIT | buffer-from | 1.1.2 | https://github.com/LinusU/buffer-from#readme |
| MIT | busboy | 1.6.0 | https://github.com/mscdex/busboy#readme |
| MIT | bytes | 3.1.2 | https://github.com/visionmedia/bytes.js#readme |
| MIT | c12 | 3.3.4 | https://github.com/unjs/c12#readme |
| MIT | call-bind-apply-helpers | 1.0.2 | https://github.com/ljharb/call-bind-apply-helpers#readme |
| MIT | call-bound | 1.0.4 | https://github.com/ljharb/call-bound#readme |
| MIT | call-me-maybe | 1.0.2 | https://github.com/limulus/call-me-maybe#readme |
| MIT | chalk | 4.1.2 | https://github.com/chalk/chalk#readme |
| MIT | chalk-template | 0.4.0 | https://github.com/chalk/chalk-template#readme |
| MIT | chokidar | 5.0.0 | https://github.com/paulmillr/chokidar |
| MIT | chromadb-js-bindings-linux-x64-gnu | 1.3.4 | https://github.com/chroma-core/chroma#readme |
| MIT | classnames | 2.5.1 | https://github.com/JedWatson/classnames#readme |
| MIT | clsx | 2.1.1 | https://github.com/lukeed/clsx#readme |
| MIT | cmdk | 1.1.1 | https://github.com/pacocoursey/cmdk#readme |
| MIT | color | 4.2.3, 5.0.3 | https://github.com/Qix-/color#readme |
| MIT | color-convert | 2.0.1, 3.1.3 | https://github.com/Qix-/color-convert#readme |
| MIT | color-name | 1.1.4, 2.1.1 | https://github.com/colorjs/color-name |
| MIT | color-string | 1.9.1, 2.1.4 | https://github.com/Qix-/color-string#readme |
| MIT | combined-stream | 1.0.8 | https://github.com/felixge/node-combined-stream |
| MIT | command-line-args | 5.2.1 | https://github.com/75lb/command-line-args#readme |
| MIT | command-line-usage | 7.0.4 | https://github.com/75lb/command-line-usage#readme |
| MIT | commander | 6.2.0, 7.2.0 | https://github.com/tj/commander.js#readme |
| MIT | compress-commons | 7.0.1 | https://github.com/archiverjs/node-compress-commons |
| MIT | concat-stream | 2.0.0 | https://github.com/maxogden/concat-stream#readme |
| MIT | confbox | 0.2.4 | https://github.com/unjs/confbox#readme |
| MIT | content-disposition | 1.1.0 | https://github.com/jshttp/content-disposition#readme |
| MIT | content-type | 1.0.5, 2.1.0 | https://github.com/jshttp/content-type#readme |
| MIT | cookie | 0.7.2, 1.1.1 | https://github.com/jshttp/cookie#readme |
| MIT | cookie-parser | 1.4.7 | https://github.com/expressjs/cookie-parser#readme |
| MIT | cookie-signature | 1.0.6, 1.2.2 | https://github.com/visionmedia/node-cookie-signature#readme |
| MIT | core-util-is | 1.0.3 | https://github.com/isaacs/core-util-is#readme |
| MIT | cors | 2.8.6 | https://github.com/expressjs/cors#readme |
| MIT | crc32-stream | 7.0.1 | https://github.com/archiverjs/node-crc32-stream |
| MIT | cron-parser | 5.10.0 | https://github.com/harrisiirak/cron-parser#readme |
| MIT | cross-spawn | 7.0.6 | https://github.com/moxystudio/node-cross-spawn |
| MIT | css-tree | 3.2.1 | https://github.com/csstree/csstree#readme |
| MIT | cssesc | 3.0.0 | https://mths.be/cssesc |
| MIT | csstype | 3.2.3 | https://github.com/frenic/csstype#readme |
| MIT | data-urls | 7.0.0 | https://github.com/jsdom/data-urls#readme |
| MIT | debug | 4.4.3 | https://github.com/debug-js/debug#readme |
| MIT | decimal.js | 10.6.0 | https://github.com/MikeMcl/decimal.js#readme |
| MIT | decimal.js-light | 2.5.1 | https://github.com/MikeMcl/decimal.js-light#readme |
| MIT | define-data-property | 1.1.4 | https://github.com/ljharb/define-data-property#readme |
| MIT | define-properties | 1.2.1 | https://github.com/ljharb/define-properties#readme |
| MIT | defu | 6.1.7 | https://github.com/unjs/defu#readme |
| MIT | delayed-stream | 1.0.0 | https://github.com/felixge/node-delayed-stream |
| MIT | depd | 2.0.0 | https://github.com/dougwilson/nodejs-depd#readme |
| MIT | destr | 2.0.5 | https://github.com/unjs/destr#readme |
| MIT | detect-node | 2.1.0 | https://github.com/iliakan/detect-node |
| MIT | detect-node-es | 1.1.0 | https://github.com/thekashey/detect-node |
| MIT | dunder-proto | 1.0.1 | https://github.com/es-shims/dunder-proto#readme |
| MIT | ee-first | 1.1.1 | https://github.com/jonathanong/ee-first#readme |
| MIT | effect | 3.20.0 | https://effect.website |
| MIT | emoji-regex | 10.6.0 | https://mths.be/emoji-regex |
| MIT | empathic | 2.0.0 | https://github.com/lukeed/empathic#readme |
| MIT | enabled | 2.0.0 | https://github.com/3rd-Eden/enabled#readme |
| MIT | encodeurl | 2.0.0 | https://github.com/pillarjs/encodeurl#readme |
| MIT | env-paths | 3.0.0 | https://github.com/sindresorhus/env-paths#readme |
| MIT | es-define-property | 1.0.1 | https://github.com/ljharb/es-define-property#readme |
| MIT | es-errors | 1.3.0 | https://github.com/ljharb/es-errors#readme |
| MIT | es-object-atoms | 1.1.2 | https://github.com/ljharb/es-object-atoms#readme |
| MIT | es-set-tostringtag | 2.1.0 | https://github.com/es-shims/es-set-tostringtag#readme |
| MIT | es-toolkit | 1.52.0 | https://es-toolkit.dev |
| MIT | es6-error | 4.1.1 | https://github.com/bjyoungblood/es6-error |
| MIT | esbuild | 0.28.2 | https://github.com/evanw/esbuild#readme |
| MIT | escalade | 3.2.0 | https://github.com/lukeed/escalade#readme |
| MIT | escape-html | 1.0.3 | https://github.com/component/escape-html#readme |
| MIT | escape-string-regexp | 4.0.0 | https://github.com/sindresorhus/escape-string-regexp#readme |
| MIT | etag | 1.8.1 | https://github.com/jshttp/etag#readme |
| MIT | event-target-shim | 5.0.1 | https://github.com/mysticatea/event-target-shim |
| MIT | eventemitter3 | 4.0.7, 5.0.4 | https://github.com/primus/eventemitter3#readme |
| MIT | events | 3.3.0 | https://github.com/Gozala/events#readme |
| MIT | eventsource | 3.0.7 | https://github.com/EventSource/eventsource#readme |
| MIT | eventsource-parser | 3.1.1 | https://github.com/rexxars/eventsource-parser#readme |
| MIT | express | 5.2.1 | https://expressjs.com/ |
| MIT | express-rate-limit | 8.7.0 | https://github.com/express-rate-limit/express-rate-limit |
| MIT | exsolve | 1.1.1 | https://github.com/unjs/exsolve#readme |
| MIT | extend-shallow | 2.0.1 | https://github.com/jonschlinkert/extend-shallow |
| MIT | fast-check | 3.23.2 | https://fast-check.dev/ |
| MIT | fast-decode-uri-component | 1.0.1 | https://github.com/delvedor/fast-decode-uri-component#readme |
| MIT | fast-deep-equal | 3.1.3 | https://github.com/epoberezkin/fast-deep-equal#readme |
| MIT | fast-fifo | 1.3.2 | https://github.com/mafintosh/fast-fifo |
| MIT | fast-querystring | 1.1.2 | https://github.com/anonrig/fast-querystring#readme |
| MIT | fecha | 4.2.3 | https://github.com/taylorhakes/fecha |
| MIT | fflate | 0.8.3 | https://101arrowz.github.io/fflate |
| MIT | file-selector | 2.1.2 | https://github.com/react-dropzone/file-selector |
| MIT | file-type | 22.0.2 | https://github.com/sindresorhus/file-type#readme |
| MIT | finalhandler | 2.1.1 | https://github.com/pillarjs/finalhandler#readme |
| MIT | find-my-way | 9.7.0 | https://github.com/delvedor/find-my-way#readme |
| MIT | find-replace | 3.0.0 | https://github.com/75lb/find-replace#readme |
| MIT | fn.name | 1.1.0 | https://github.com/3rd-Eden/fn.name |
| MIT | follow-redirects | 1.16.0 | https://github.com/follow-redirects/follow-redirects |
| MIT | form-data | 4.0.6 | https://github.com/form-data/form-data#readme |
| MIT | form-data-encoder | 1.7.2 | https://github.com/octet-stream/form-data-encoder#readme |
| MIT | formdata-node | 4.4.1 | https://github.com/octet-stream/form-data#readme |
| MIT | forwarded | 0.2.0 | https://github.com/jshttp/forwarded#readme |
| MIT | fresh | 2.0.0 | https://github.com/jshttp/fresh#readme |
| MIT | function-bind | 1.1.2 | https://github.com/Raynos/function-bind |
| MIT | generate-function | 2.3.1 | https://github.com/mafintosh/generate-function |
| MIT | get-east-asian-width | 1.6.0 | https://github.com/sindresorhus/get-east-asian-width#readme |
| MIT | get-intrinsic | 1.3.0 | https://github.com/ljharb/get-intrinsic#readme |
| MIT | get-nonce | 1.0.1 | https://github.com/theKashey/get-nonce |
| MIT | get-port-please | 3.2.0 | https://github.com/unjs/get-port-please#readme |
| MIT | get-proto | 1.0.1 | https://github.com/ljharb/get-proto#readme |
| MIT | giget | 3.3.1 | https://github.com/unjs/giget#readme |
| MIT | globalthis | 1.0.4 | https://github.com/ljharb/System.global#readme |
| MIT | gopd | 1.2.0 | https://github.com/ljharb/gopd#readme |
| MIT | grammex | 3.1.13 | https://github.com/fabiospampinato/grammex#readme |
| MIT | graphmatch | 1.1.1 | https://github.com/fabiospampinato/graphmatch#readme |
| MIT | graphology | 0.26.0 | https://github.com/graphology/graphology#readme |
| MIT | graphology-communities-louvain | 2.0.2 | https://github.com/graphology/graphology#readme |
| MIT | graphology-indices | 0.17.0 | https://github.com/graphology/graphology#readme |
| MIT | graphology-utils | 2.5.2 | https://github.com/graphology/graphology#readme |
| MIT | gray-matter | 4.0.3 | https://github.com/jonschlinkert/gray-matter |
| MIT | has-flag | 4.0.0 | https://github.com/sindresorhus/has-flag#readme |
| MIT | has-property-descriptors | 1.0.2 | https://github.com/inspect-js/has-property-descriptors#readme |
| MIT | has-symbols | 1.1.0 | https://github.com/ljharb/has-symbols#readme |
| MIT | has-tostringtag | 1.0.2 | https://github.com/inspect-js/has-tostringtag#readme |
| MIT | hasown | 2.0.4 | https://github.com/inspect-js/hasOwn#readme |
| MIT | helmet | 8.3.0 | https://helmet.js.org/ |
| MIT | hono | 4.13.5 | https://hono.dev |
| MIT | html-encoding-sniffer | 6.0.0 | https://github.com/jsdom/html-encoding-sniffer#readme |
| MIT | html-parse-stringify | 4.0.1 | https://github.com/i18next/html-parse-stringify |
| MIT | http_ece | 1.2.0 | https://github.com/martinthomson/encrypted-content-encoding |
| MIT | http-errors | 2.0.1 | https://github.com/jshttp/http-errors#readme |
| MIT | https-proxy-agent | 5.0.1, 7.0.6 | https://github.com/TooTallNate/proxy-agents#readme |
| MIT | humanize-ms | 1.2.1 | https://github.com/node-modules/humanize-ms#readme |
| MIT | i18next | 26.4.0 | https://www.i18next.com |
| MIT | iconv-lite | 0.6.3, 0.7.3 | https://github.com/pillarjs/iconv-lite |
| MIT | immediate | 3.0.6 | https://github.com/calvinmetcalf/immediate#readme |
| MIT | immer | 11.1.18 | https://github.com/immerjs/immer#readme |
| MIT | ioredis | 5.11.1 | https://github.com/luin/ioredis#readme |
| MIT | ip-address | 10.7.0 | https://github.com/beaugunderson/ip-address#readme |
| MIT | ipaddr.js | 1.9.1 | https://github.com/whitequark/ipaddr.js#readme |
| MIT | is-arrayish | 0.3.4 | https://github.com/qix-/node-is-arrayish#readme |
| MIT | is-buffer | 1.1.6 | https://github.com/feross/is-buffer#readme |
| MIT | is-extendable | 0.1.1 | https://github.com/jonschlinkert/is-extendable |
| MIT | is-potential-custom-element-name | 1.0.1 | https://github.com/mathiasbynens/is-potential-custom-element-name |
| MIT | is-promise | 4.0.0 | https://github.com/then/is-promise#readme |
| MIT | is-property | 1.0.2 | https://github.com/mikolalysenko/is-property#readme |
| MIT | is-stream | 2.0.1, 4.0.1 | https://github.com/sindresorhus/is-stream#readme |
| MIT | is-url | 1.2.4 | https://github.com/segmentio/is-url#readme |
| MIT | isarray | 1.0.0 | https://github.com/juliangruber/isarray |
| MIT | jiti | 2.7.0 | https://github.com/unjs/jiti#readme |
| MIT | jose | 6.2.10 | https://github.com/panva/jose |
| MIT | js-tiktoken | 1.0.21 | https://github.com/dqbd/tiktoken#readme |
| MIT | js-tokens | 4.0.0 | https://github.com/lydell/js-tokens#readme |
| MIT | js-yaml | 3.15.2, 4.3.2 | https://github.com/nodeca/js-yaml#readme |
| MIT | jsdom | 29.1.1 | https://github.com/jsdom/jsdom#readme |
| MIT | json-bignum | 0.0.3 | https://github.com/datalanche/json-bignum |
| MIT | json-schema-traverse | 1.0.0 | https://github.com/epoberezkin/json-schema-traverse#readme |
| MIT | jsonwebtoken | 9.0.3 | https://github.com/auth0/node-jsonwebtoken#readme |
| MIT | jwa | 2.0.1 | https://github.com/brianloveswords/node-jwa#readme |
| MIT | jws | 4.0.1 | https://github.com/brianloveswords/node-jws#readme |
| MIT | kind-of | 6.0.3 | https://github.com/jonschlinkert/kind-of |
| MIT | kuler | 2.0.0 | https://github.com/3rd-Eden/kuler |
| MIT | langsmith | 0.9.0 | https://github.com/langchain-ai/langsmith-sdk#readme |
| MIT | lazystream | 1.0.1 | https://github.com/jpommerening/node-lazystream |
| MIT | lie | 3.3.0 | https://github.com/calvinmetcalf/lie#readme |
| MIT | lilconfig | 3.1.3 | https://github.com/antonk52/lilconfig#readme |
| MIT | linkify-it | 5.0.2 | https://github.com/markdown-it/linkify-it#readme |
| MIT | lodash | 4.18.1 | https://lodash.com/ |
| MIT | lodash.camelcase | 4.3.0 | https://lodash.com/ |
| MIT | lodash.includes | 4.3.0 | https://lodash.com/ |
| MIT | lodash.isboolean | 3.0.3 | https://lodash.com/ |
| MIT | lodash.isinteger | 4.0.4 | https://lodash.com/ |
| MIT | lodash.isnumber | 3.0.3 | https://lodash.com/ |
| MIT | lodash.isplainobject | 4.0.6 | https://lodash.com/ |
| MIT | lodash.isstring | 4.0.1 | https://lodash.com/ |
| MIT | lodash.mergewith | 4.6.2 | https://lodash.com/ |
| MIT | lodash.once | 4.1.1 | https://lodash.com/ |
| MIT | logform | 2.7.0 | https://github.com/winstonjs/logform#readme |
| MIT | loose-envify | 1.4.0 | https://github.com/zertosh/loose-envify |
| MIT | lru.min | 1.1.4 | https://github.com/wellwelwel/lru.min#readme |
| MIT | luxon | 3.7.2 | https://github.com/moment/luxon#readme |
| MIT | markdown-it | 14.3.1 | https://github.com/markdown-it/markdown-it#readme |
| MIT | matcher | 3.0.0 | https://github.com/sindresorhus/matcher#readme |
| MIT | math-intrinsics | 1.1.0 | https://github.com/es-shims/math-intrinsics#readme |
| MIT | mdurl | 2.1.0 | https://github.com/markdown-it/mdurl#readme |
| MIT | media-typer | 0.3.0, 1.1.1 | https://github.com/jshttp/media-typer#readme |
| MIT | merge-descriptors | 2.0.0 | https://github.com/sindresorhus/merge-descriptors#readme |
| MIT | mime-db | 1.52.0, 1.54.0 | https://github.com/jshttp/mime-db#readme |
| MIT | mime-types | 2.1.35, 3.0.2 | https://github.com/jshttp/mime-types#readme |
| MIT | minimist | 1.2.8 | https://github.com/minimistjs/minimist |
| MIT | minizlib | 3.1.0 | https://github.com/isaacs/minizlib#readme |
| MIT | mitt | 3.0.1 | https://github.com/developit/mitt |
| MIT | mnemonist | 0.39.8 | https://github.com/yomguithereal/mnemonist#readme |
| MIT | modern-tar | 0.8.4 | https://github.com/ayuhito/modern-tar |
| MIT | ms | 2.1.3 | https://github.com/vercel/ms#readme |
| MIT | multer | 2.3.0 | https://github.com/expressjs/multer#readme |
| MIT | mustache | 4.2.0 | https://github.com/janl/mustache.js |
| MIT | mysql2 | 3.15.3 | https://sidorares.github.io/node-mysql2/docs |
| MIT | named-placeholders | 1.1.6 | https://github.com/mysqljs/named-placeholders#readme |
| MIT | negotiator | 1.1.0 | https://github.com/jshttp/negotiator#readme |
| MIT | node-abort-controller | 3.1.1 | https://github.com/southpolesteve/node-abort-controller#readme |
| MIT | node-domexception | 1.0.0 | https://github.com/jimmywarting/node-domexception#readme |
| MIT | node-ensure | 0.0.0 | https://github.com/bauerca/node-ensure |
| MIT | node-fetch | 2.7.0 | https://github.com/bitinn/node-fetch |
| MIT | non-error | 0.1.0 | https://github.com/sindresorhus/non-error#readme |
| MIT | normalize-path | 3.0.0 | https://github.com/jonschlinkert/normalize-path |
| MIT | object-assign | 4.1.1 | https://github.com/sindresorhus/object-assign#readme |
| MIT | object-inspect | 1.13.4 | https://github.com/inspect-js/object-inspect |
| MIT | object-keys | 1.1.1 | https://github.com/ljharb/object-keys#readme |
| MIT | obliterator | 2.0.5 | https://github.com/yomguithereal/obliterator#readme |
| MIT | officeparser | 7.8.0 | https://officeparser.harshankur.com |
| MIT | ohash | 2.0.12 | https://github.com/unjs/ohash#readme |
| MIT | ollama | 0.6.3 | https://github.com/ollama/ollama-js |
| MIT | on-finished | 2.4.1 | https://github.com/jshttp/on-finished#readme |
| MIT | one-time | 1.0.0 | https://github.com/3rd-Eden/one-time#readme |
| MIT | onnx-proto | 4.0.4 | https://github.com/chaosmail/onnx-proto#readme |
| MIT | onnxruntime-common | 1.14.0, 1.19.2, 1.20.0-dev.20241016-2b8fc5529b, 1.24.0-dev.20251116-b39e144322, 1.24.3 | https://github.com/Microsoft/onnxruntime#readme |
| MIT | onnxruntime-node | 1.14.0, 1.19.2, 1.24.3 | https://github.com/Microsoft/onnxruntime#readme |
| MIT | onnxruntime-web | 1.14.0, 1.21.0-dev.20241024-d9ca84ef96, 1.26.0-dev.20260416-b7804b056c | https://github.com/Microsoft/onnxruntime#readme |
| MIT | opencollective-postinstall | 2.0.3 | https://github.com/opencollective/opencollective-postinstall#readme |
| MIT | p-finally | 1.0.0 | https://github.com/sindresorhus/p-finally#readme |
| MIT | p-queue | 6.6.2 | https://github.com/sindresorhus/p-queue#readme |
| MIT | p-timeout | 3.2.0 | https://github.com/sindresorhus/p-timeout#readme |
| MIT | pandemonium | 2.4.1 | https://github.com/yomguithereal/pandemonium#readme |
| MIT | parse5 | 8.0.1 | https://parse5.js.org |
| MIT | parseurl | 1.3.3 | https://github.com/pillarjs/parseurl#readme |
| MIT | path-is-absolute | 1.0.1 | https://github.com/sindresorhus/path-is-absolute#readme |
| MIT | path-key | 3.1.1 | https://github.com/sindresorhus/path-key#readme |
| MIT | path-to-regexp | 8.4.2 | https://github.com/pillarjs/path-to-regexp#readme |
| MIT | pathe | 2.0.3 | https://github.com/unjs/pathe#readme |
| MIT | pdf-parse | 1.1.4 | https://github.com/mehmet-kozan/pdf-parse |
| MIT | perfect-debounce | 2.1.0 | https://github.com/unjs/perfect-debounce#readme |
| MIT | pg | 8.23.0 | https://github.com/brianc/node-postgres |
| MIT | pg-boss | 12.29.0 | https://pgboss.io |
| MIT | pg-cloudflare | 1.4.0 | https://github.com/brianc/node-postgres#readme |
| MIT | pg-connection-string | 2.14.0 | https://github.com/brianc/node-postgres/tree/master/packages/pg-connection-string |
| MIT | pg-pool | 3.14.0 | https://github.com/brianc/node-postgres/tree/master/packages/pg-pool#readme |
| MIT | pg-protocol | 1.16.0 | https://github.com/brianc/node-postgres#readme |
| MIT | pg-types | 2.2.0 | https://github.com/brianc/node-pg-types |
| MIT | pgpass | 1.0.5 | https://github.com/hoegaarden/pgpass#readme |
| MIT | pgvector | 0.3.0 | https://github.com/pgvector/pgvector-node |
| MIT | pkce-challenge | 5.0.1 | https://github.com/crouchcd/pkce-challenge#readme |
| MIT | pkg-types | 2.3.1 | https://github.com/unjs/pkg-types#readme |
| MIT | platform | 1.3.6 | https://github.com/bestiejs/platform.js#readme |
| MIT | postcss-selector-parser | 6.0.10 | https://github.com/postcss/postcss-selector-parser |
| MIT | postgres-array | 2.0.0, 3.0.4 | https://github.com/bendrucker/postgres-array#readme |
| MIT | postgres-bytea | 1.0.1 | https://github.com/bendrucker/postgres-bytea#readme |
| MIT | postgres-date | 1.0.7 | https://github.com/bendrucker/postgres-date#readme |
| MIT | postgres-interval | 1.2.0 | https://github.com/bendrucker/postgres-interval#readme |
| MIT | preact | 10.29.8 | https://preactjs.com |
| MIT | process | 0.11.10 | https://github.com/shtylman/node-process#readme |
| MIT | process-nextick-args | 2.0.1 | https://github.com/calvinmetcalf/process-nextick-args |
| MIT | prop-types | 15.8.1 | https://facebook.github.io/react/ |
| MIT | proper-lockfile | 4.1.2 | https://github.com/moxystudio/node-proper-lockfile |
| MIT | proxy-addr | 2.0.7 | https://github.com/jshttp/proxy-addr#readme |
| MIT | proxy-from-env | 2.1.0 | https://github.com/Rob--W/proxy-from-env#readme |
| MIT | punycode | 2.3.1 | https://mths.be/punycode |
| MIT | punycode.js | 2.3.1 | https://mths.be/punycode |
| MIT | pure-rand | 6.1.0 | https://github.com/dubzzz/pure-rand#readme |
| MIT | radix-ui | 1.6.7 | https://radix-ui.com/primitives |
| MIT | range-parser | 1.3.0 | https://github.com/jshttp/range-parser#readme |
| MIT | rate-limit-redis | 6.0.1 | https://github.com/express-rate-limit/rate-limit-redis |
| MIT | raw-body | 3.0.2 | https://github.com/stream-utils/raw-body#readme |
| MIT | rc9 | 3.0.1 | https://github.com/unjs/rc9#readme |
| MIT | react | 19.2.8 | https://react.dev/ |
| MIT | react-dom | 19.2.8 | https://react.dev/ |
| MIT | react-dropzone | 15.0.0 | https://github.com/react-dropzone/react-dropzone |
| MIT | react-hook-form | 7.87.0 | https://react-hook-form.com |
| MIT | react-i18next | 17.0.12 | https://github.com/i18next/react-i18next |
| MIT | react-is | 16.13.1, 19.2.8 | https://react.dev/ |
| MIT | react-redux | 9.3.0 | https://github.com/reduxjs/react-redux |
| MIT | react-remove-scroll | 2.7.2 | https://github.com/theKashey/react-remove-scroll#readme |
| MIT | react-remove-scroll-bar | 2.3.8 | https://github.com/theKashey/react-remove-scroll-bar#readme |
| MIT | react-router | 7.18.3 | https://github.com/remix-run/react-router#readme |
| MIT | react-router-dom | 7.18.3 | https://github.com/remix-run/react-router#readme |
| MIT | react-style-singleton | 2.2.3 | https://github.com/theKashey/react-style-singleton#readme |
| MIT | readable-stream | 2.3.8, 3.6.2, 4.7.0 | https://github.com/nodejs/readable-stream |
| MIT | readdirp | 5.1.1 | https://github.com/paulmillr/readdirp |
| MIT | recharts | 3.10.1 | https://github.com/recharts/recharts |
| MIT | redis-errors | 1.2.0 | https://github.com/NodeRedis/redis-errors#readme |
| MIT | redis-parser | 3.0.0 | https://github.com/NodeRedis/node-redis-parser#readme |
| MIT | redlock | 5.0.0-beta.2 | https://github.com/mike-marcacci/node-redlock#readme |
| MIT | redux | 5.0.1 | http://redux.js.org |
| MIT | redux-thunk | 3.1.0 | https://github.com/reduxjs/redux-thunk |
| MIT | regenerator-runtime | 0.13.11 | https://github.com/facebook/regenerator/tree/main#readme |
| MIT | remeda | 2.33.4 | https://remedajs.com/ |
| MIT | require-from-string | 2.0.2 | https://github.com/floatdrop/require-from-string#readme |
| MIT | reselect | 5.2.0 | https://github.com/reduxjs/reselect#readme |
| MIT | ret | 0.5.0 | https://github.com/fent/ret.js#readme |
| MIT | retry | 0.12.0 | https://github.com/tim-kos/node-retry |
| MIT | router | 2.2.0 | https://github.com/pillarjs/router#readme |
| MIT | safe-buffer | 5.1.2, 5.2.1 | https://github.com/feross/safe-buffer |
| MIT | safe-regex2 | 5.1.1 | https://github.com/fastify/safe-regex2 |
| MIT | safe-stable-stringify | 2.5.0 | https://github.com/BridgeAR/safe-stable-stringify#readme |
| MIT | safer-buffer | 2.1.2 | https://github.com/ChALkeR/safer-buffer#readme |
| MIT | scheduler | 0.27.0 | https://react.dev/ |
| MIT | section-matter | 1.0.0 | https://github.com/jonschlinkert/section-matter |
| MIT | semver-compare | 1.0.0 | https://github.com/substack/semver-compare |
| MIT | send | 1.2.1 | https://github.com/pillarjs/send#readme |
| MIT | seq-queue | 0.0.5 | https://github.com/changchang/seq-queue |
| MIT | serialize-error | 7.0.1, 13.0.1 | https://github.com/sindresorhus/serialize-error#readme |
| MIT | serve-static | 2.2.1 | https://github.com/expressjs/serve-static#readme |
| MIT | set-cookie-parser | 2.7.2 | https://github.com/nfriedly/set-cookie-parser |
| MIT | setimmediate | 1.0.5 | https://github.com/YuzuJS/setImmediate#readme |
| MIT | shebang-command | 2.0.0 | https://github.com/kevva/shebang-command#readme |
| MIT | shebang-regex | 3.0.0 | https://github.com/sindresorhus/shebang-regex#readme |
| MIT | side-channel | 1.1.1 | https://github.com/ljharb/side-channel#readme |
| MIT | side-channel-list | 1.0.1 | https://github.com/ljharb/side-channel-list#readme |
| MIT | side-channel-map | 1.0.1 | https://github.com/ljharb/side-channel-map#readme |
| MIT | side-channel-weakmap | 1.0.2 | https://github.com/ljharb/side-channel-weakmap#readme |
| MIT | simple-git | 3.36.0 | https://github.com/steveukx/git-js#readme |
| MIT | simple-swizzle | 0.2.4 | https://github.com/qix-/node-simple-swizzle#readme |
| MIT | sonner | 2.0.8 | https://sonner.emilkowal.ski/ |
| MIT | sqlstring | 2.3.3 | https://github.com/mysqljs/sqlstring#readme |
| MIT | stack-trace | 0.0.10 | https://github.com/felixge/node-stack-trace |
| MIT | standard-as-callback | 2.1.0 | https://github.com/luin/asCallback#readme |
| MIT | statuses | 2.0.2 | https://github.com/jshttp/statuses#readme |
| MIT | std-env | 3.10.0 | https://github.com/unjs/std-env#readme |
| MIT | streamsearch | 1.1.0 | https://github.com/mscdex/streamsearch#readme |
| MIT | streamx | 2.28.1 | https://github.com/mafintosh/streamx |
| MIT | string_decoder | 1.1.1, 1.3.0 | https://github.com/nodejs/string_decoder |
| MIT | string-width | 7.2.0, 8.2.2 | https://github.com/sindresorhus/string-width#readme |
| MIT | strip-ansi | 7.2.0 | https://github.com/chalk/strip-ansi#readme |
| MIT | strip-bom-string | 1.0.0 | https://github.com/jonschlinkert/strip-bom-string |
| MIT | strtok3 | 10.3.5 | https://github.com/Borewit/strtok3#readme |
| MIT | supports-color | 7.2.0, 8.1.1 | https://github.com/chalk/supports-color#readme |
| MIT | swagger-jsdoc | 6.3.0 | https://github.com/Surnet/swagger-jsdoc |
| MIT | swagger-ui-express | 5.0.1 | https://github.com/scottie1984/swagger-ui-express |
| MIT | symbol-tree | 3.2.4 | https://github.com/jsdom/js-symbol-tree#symbol-tree |
| MIT | table-layout | 4.1.1 | https://github.com/75lb/table-layout#readme |
| MIT | tagged-tag | 1.0.0 | https://github.com/sindresorhus/tagged-tag#readme |
| MIT | tailwind-merge | 3.6.0 | https://github.com/dcastil/tailwind-merge |
| MIT | tailwindcss | 4.3.3 | https://tailwindcss.com |
| MIT | tar-stream | 3.2.1 | https://github.com/mafintosh/tar-stream |
| MIT | teex | 1.0.1 | https://github.com/mafintosh/teex |
| MIT | text-hex | 1.0.0 | https://github.com/3rd-Eden/text-hex |
| MIT | tiny-invariant | 1.3.3 | https://github.com/alexreardon/tiny-invariant#readme |
| MIT | tldts | 7.4.11 | https://github.com/remusao/tldts#readme |
| MIT | tldts-core | 7.4.11 | https://github.com/remusao/tldts#readme |
| MIT | toidentifier | 1.0.1 | https://github.com/component/toidentifier#readme |
| MIT | token-types | 6.1.2 | https://github.com/Borewit/token-types#readme |
| MIT | tr46 | 0.0.3, 6.0.0 | https://github.com/jsdom/tr46#readme |
| MIT | triple-beam | 1.4.1 | https://github.com/winstonjs/triple-beam#readme |
| MIT | tsx | 4.23.13 | https://tsx.hirok.io |
| MIT | turndown | 7.2.4 | https://github.com/mixmark-io/turndown#readme |
| MIT | tw-animate-css | 1.4.0 | https://github.com/Wombosvideo/tw-animate-css#readme |
| MIT | type-is | 1.6.18, 2.1.0 | https://github.com/jshttp/type-is#readme |
| MIT | typed-query-selector | 2.12.2 | https://github.com/g-plane/typed-query-selector#readme |
| MIT | typedarray | 0.0.6 | https://github.com/substack/typedarray |
| MIT | typical | 4.0.0, 7.3.0 | https://github.com/75lb/typical#readme |
| MIT | uc.micro | 2.1.0 | https://github.com/markdown-it/uc.micro#readme |
| MIT | uint8array-extras | 1.5.0 | https://github.com/sindresorhus/uint8array-extras#readme |
| MIT | underscore | 1.13.8 | https://underscorejs.org |
| MIT | undici | 7.29.0 | https://undici.nodejs.org |
| MIT | undici-types | 5.26.5, 6.21.0, 8.3.0 | https://undici.nodejs.org |
| MIT | unpipe | 1.0.0 | https://github.com/stream-utils/unpipe#readme |
| MIT | use-callback-ref | 1.3.3 | https://github.com/theKashey/use-callback-ref#readme |
| MIT | use-sidecar | 1.1.3 | https://github.com/theKashey/use-sidecar |
| MIT | use-sync-external-store | 1.6.0 | https://github.com/facebook/react#readme |
| MIT | util-deprecate | 1.0.2 | https://github.com/TooTallNate/util-deprecate |
| MIT | uuid | 14.0.2 | https://github.com/uuidjs/uuid#readme |
| MIT | valibot | 1.4.2 | https://valibot.dev |
| MIT | vary | 1.1.2 | https://github.com/jshttp/vary#readme |
| MIT | w3c-xmlserializer | 5.0.0 | https://github.com/jsdom/w3c-xmlserializer#readme |
| MIT | web-streams-polyfill | 3.3.3, 4.0.0-beta.3 | https://github.com/MattiasBuelens/web-streams-polyfill#readme |
| MIT | whatwg-fetch | 3.6.20 | https://github.com/github/fetch#readme |
| MIT | whatwg-mimetype | 5.0.0 | https://github.com/jsdom/whatwg-mimetype#readme |
| MIT | whatwg-url | 5.0.0, 16.0.1 | https://github.com/jsdom/whatwg-url#readme |
| MIT | winston | 3.19.0 | https://github.com/winstonjs/winston#readme |
| MIT | winston-transport | 4.9.0 | https://github.com/winstonjs/winston-transport#readme |
| MIT | wordwrapjs | 5.1.1 | https://github.com/75lb/wordwrapjs#readme |
| MIT | wrap-ansi | 9.0.2 | https://github.com/chalk/wrap-ansi#readme |
| MIT | ws | 8.21.3 | https://github.com/websockets/ws |
| MIT | xmlbuilder | 10.1.1 | http://github.com/oozcitak/xmlbuilder-js |
| MIT | xmlchars | 2.2.0 | https://github.com/lddubeau/xmlchars#readme |
| MIT | xtend | 4.0.2 | https://github.com/Raynos/xtend |
| MIT | yargs | 18.1.0 | https://yargs.js.org/ |
| MIT | youtube-transcript-plus | 2.0.1 | https://github.com/ericmmartin/youtube-transcript-plus |
| MIT | zeptomatch | 2.1.0 | https://github.com/fabiospampinato/zeptomatch#readme |
| MIT | zip-stream | 7.0.5 | https://github.com/archiverjs/node-zip-stream |
| MIT | zlibjs | 0.3.1 | https://github.com/imaya/zlib.js |
| MIT | zod | 3.25.76, 4.5.4 | https://zod.dev |
| MIT and ISC | @visx/vendor | 4.0.0-alpha.0 | https://github.com/airbnb/visx#readme |
| MIT AND ISC | victory-vendor | 37.3.6 | https://commerce.nearform.com/open-source/victory |
| MIT-0 | @csstools/color-helpers | 6.1.1 | https://github.com/csstools/postcss-plugins/tree/main/packages/color-helpers#readme |
| MIT-0 | @csstools/css-syntax-patches-for-csstree | 1.1.10 | https://github.com/csstools/postcss-plugins/tree/main/packages/css-syntax-patches-for-csstree#readme |
| MPL-2.0 | web-push | 3.6.7 | https://github.com/web-push-libs/web-push#readme |
| OFL-1.1 | @fontsource-variable/geist | 5.3.0 | https://fontsource.org/fonts/geist |
| OFL-1.1 | @fontsource-variable/inter | 5.3.0 | https://fontsource.org/fonts/inter |
| OFL-1.1 | @fontsource/jetbrains-mono | 5.3.0 | https://fontsource.org/fonts/jetbrains-mono |
| Python-2.0 | argparse | 2.0.1 | https://github.com/nodeca/argparse#readme |
| Unknown | flatbuffers | 1.12.0 | https://google.github.io/flatbuffers/ |
| Unlicense | postgres | 3.4.7 | https://github.com/porsager/postgres |
| Unlicense | robust-predicates | 3.0.3 | https://github.com/mourner/robust-predicates#readme |
<!-- END AUTO-GENERATED -->

---

## Disclaimer

This file is engineering attribution, not legal advice. For binding
licensing decisions (especially before public distribution of binaries or
container images), consult a qualified attorney.