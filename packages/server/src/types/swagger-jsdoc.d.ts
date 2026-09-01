// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

declare module 'swagger-jsdoc' {
  interface Options {
    definition?: Record<string, unknown>;
    swaggerDefinition?: Record<string, unknown>;
    apis: string[];
    encoding?: string;
    failOnErrors?: boolean;
    verbose?: boolean;
    format?: string;
  }

  function swaggerJsdoc(options: Options): object;

  namespace swaggerJsdoc {
    export type { Options };
  }

  export = swaggerJsdoc;
}
