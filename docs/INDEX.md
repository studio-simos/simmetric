
# Simmetric Chat Documentation

Welcome to the Simmetric Chat documentation. This is a local-first, privacy-first AI chat workspace with RAG, RBAC, and full air-gap capability.

This index is the hub for the 9 canonical development docs. Each canonical doc links back here (and to 2–3 adjacent docs) in a "See also" footer. User guides and the widget integration guide are listed separately.

---

## Getting Started

| Document | Description |
|----------|-------------|
| [GETTING_STARTED.md](GETTING_STARTED.md) | Install, configure, first run, seeding, first-time setup paths |

---

## Development

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, component diagram, data flow, key architectural patterns |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local development setup, monorepo workflow, code style, adding routes/packages |
| [TESTING.md](TESTING.md) | Test framework, commands, integration harness, E2E, CI pipeline |
| [CONFIGURATION.md](CONFIGURATION.md) | Full environment variable reference, LLM/embedding/vector providers, license, SSO, rate limits |

---

## Reference

| Document | Description |
|----------|-------------|
| [API.md](API.md) | REST API reference: auth, workspaces, chat/SSE, widgets, MCP, backups, restore |
| [WIDGET.md](WIDGET.md) | Embeddable chat widget integration guide + `simmetric:*` postMessage protocol reference |

---

## Enterprise

| Document | Description |
|----------|-------------|
| [ENTERPRISE_PLUGIN.md](ENTERPRISE_PLUGIN.md) | Enterprise plugin model, PluginContext contract, extraction history, air-gap install runbook, tarball delivery, license JWT shape |
| [ENTERPRISE_LAUNCH.md](ENTERPRISE_LAUNCH.md) | Step-by-step: enable Enterprise with pnpm (local) or Docker (compose) — build, license, mount, verify |

---

## Operations

| Document | Description |
|----------|-------------|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Multi-container & single-container Docker deployment, TLS, backups, air-gap notes |

---

## Contributing

| Document | Description |
|----------|-------------|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Coding standards, monorepo conventions, PR guidelines, CI pipeline |

---

## User Guides

Guides for end users and administrators. These are NOT part of the 9 canonical dev docs but are still useful.

| Document | Description |
|----------|-------------|
| [USAGE.md](USAGE.md) | Feature guide: chat, documents, widgets, MCP, settings, analytics |
| [ADMIN.md](ADMIN.md) | RBAC, roles, license management, and admin tasks |
| [MCP_MARKETPLACE.md](MCP_MARKETPLACE.md) | MCP Marketplace: browse, install, and manage MCP servers |

---

## External Resources

- **API Documentation**: Swagger UI served at `/api-docs` when the server is running
- **OpenAPI Spec**: `/api-docs/json` for raw OpenAPI 3.0 JSON
- **GitHub**: Source code and issues

---

## See also

- [README.md](../README.md) — project overview, quick start, tech stack
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to contribute