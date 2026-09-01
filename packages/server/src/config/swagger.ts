// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import swaggerJSDoc from "swagger-jsdoc";
import path from "path";
import { getEnv } from "./env";

const env = getEnv();

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Simmetric Chat API",
      version: "1.0.0",
      description:
        "Enterprise-grade AI chat workspace with RAG, RBAC, and full air-gap capability. " +
        "Supports both JSON and SSE streaming responses.",
    },
    servers: [
      { url: `http://localhost:${env.SERVER_PORT}/api`, description: "Local development" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT token obtained from /api/auth/login",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Api-Key",
          description: "API key with sk- prefix",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Not found" },
          },
        },
        FeatureRequired: {
          type: "object",
          properties: {
            error: { type: "string", example: "This feature requires an Enterprise license" },
            feature: { type: "string", example: "webhooks" },
            tier: { type: "string", example: "community" },
          },
        },
      },
    },
    tags: [
      { name: "Auth", description: "Authentication and user management" },
      { name: "Documents", description: "Document upload and management" },
      { name: "Workspaces", description: "Workspace CRUD and access control" },
      { name: "Chat", description: "AI chat with streaming support" },
      { name: "API Keys", description: "API key management" },
    ],
  },
  apis: [path.resolve(__dirname, "../routes/*.ts")],
};

export const swaggerSpec = swaggerJSDoc(options);