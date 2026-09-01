// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { render } from "preact";
import App from "./App";
import "./index.css";

const root = document.getElementById("widget-root");
if (root) render(<App />, root);