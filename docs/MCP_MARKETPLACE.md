# MCP Marketplace User Guide

This guide covers the complete MCP Marketplace workflow, from discovering servers in the catalog to managing installed connections and controlling which tools are available in your chats. The marketplace is available to users with the **admin** role.

---

## Contents

1. [Catalog Browsing](#catalog-browsing)
2. [Server Detail Inspection](#server-detail-inspection)
3. [One-Click Installation](#one-click-installation)
4. [Enable/Disable Management](#enabledisable-management)
5. [Per-Chat Pinning](#per-chat-pinning)
6. [Troubleshooting](#troubleshooting)

---

## Catalog Browsing

The catalog is your starting point for discovering MCP servers that extend your AI assistant's capabilities with external tools.

### Opening the Marketplace

Click **Marketplace** in the sidebar navigation. This menu item is visible only to admin role. The page loads at `/mcp-marketplace` and displays a grid of available MCP server cards.

### Searching for Servers

Use the search bar at the top of the page to filter servers by name or description. Type any keyword and the results update in real-time as you type. Clear the search box to restore the full catalog.

### Filtering by Category

Below the search bar, category pills let you narrow results by domain. Click a pill to filter -- for example, **Developer Tools**, **Database**, or **Communication**. The **All** pill resets all filters. Categories are generated dynamically from the catalog data, so the available filter options reflect what is actually in the catalog.

### Understanding Server Cards

Each server appears as a card showing:

| Element | Description |
|---------|-------------|
| **Server name** | The MCP server's display name |
| **Description** | A brief summary of what the server does |
| **Category badge** | The server's domain category |
| **Verification badge** | Trust tier: burnt orange check (`official`, `variant="default"`, `bg-primary` #973C00 with cream `text-primary-foreground` icon) or beige check (`verified_community`, `variant="secondary"`); `unverified` entries show no badge |
| **Health badge** | Live status: burnt orange badge with cream dot (`healthy`, `variant="default"` — `bg-primary` #973C00 with `bg-primary-foreground` #FDFAF4 dot), beige badge with brown dot (`stale`, `variant="secondary"`), or cream dot on a light red-tinted badge (`down`, `variant="destructive"` — `bg-destructive/10` with `bg-destructive-foreground` #FDFAF4 dot) |
| **Tools label** | A static "Tools" label — no count number is shown on the card |
| **Install button** | Shows "Install" if not installed, or a three-dots menu with the Uninstall option if already installed |

---

## Server Detail Inspection

Click any server card to open its detail page at `/mcp-marketplace/:entryId`. This page shows the server's full information before you decide to install it.

### What You See

- **Full description**: A detailed explanation of the server's purpose and capabilities.
- **Author and version**: Who maintains the server and the current version number.
- **Verification tier**: A badge with a label and icon indicating the trust level. `official` servers are published by recognized maintainers. `verified_community` servers have been reviewed. `unverified` servers are listed but not yet vetted.
- **Health status**: A badge showing the last time the server's endpoint was successfully contacted. The status can be `healthy`, `stale`, or `down`.
- **Last commit date**: Indicates how recently the server has been updated, helping you assess whether it is actively maintained.

### Tool List

The detail page displays every tool the server exposes, with the tool name in bold followed by its description. No tool count is shown in the page header — the tools section lists each tool's name and description only. Review the tool descriptions to understand what capabilities the server will add to your AI assistant.

### Install Button

A prominent action button appears on the detail page. Proceed to the next section for the full installation workflow.

---

## One-Click Installation

Installing a server creates a workspace-scoped MCP connection so your AI assistant can use its tools.

### Prerequisites

You must have a workspace selected before installing. Use the workspace switcher in the sidebar to pick an active workspace. If no workspace is selected, the Install button shows a tooltip: "Select a workspace to install".

### Installation Steps

1. **Select a workspace** from the sidebar workspace switcher.
2. **Navigate to a server's detail page** by clicking its card in the catalog, or use the Install button directly on a catalog card.
3. **Click the Install button**. The system creates a workspace-scoped MCP connection with the server's default name and attempts to connect immediately. A loading indicator appears while the operation is in progress.
4. **Wait for confirmation**: Once installed, the button changes to a burnt orange "Installed" label (`text-primary`, which resolves to `--primary: #973C00` in the light and dark themes) with a checkmark. A context menu (three dots) appears next to it with an Uninstall option. The connection's tools are registered and become available to the AI assistant.

### What Happens Behind the Scenes

A new MCP connection record is created for your workspace with `source` set to `marketplace`. The system attempts to connect to the server's URL. On success, the server's tools are registered in the agent's skill registry.

### If the Connection Fails

If the server cannot be reached, the connection record is still created but marked as `disconnected`. No warning indicator is shown on the button. You can troubleshoot the connection from the MCP Connections settings tab -- see the [Enable/Disable Management](#enabledisable-management) section for details on testing and editing connections.

### Uninstalling

To remove a marketplace-installed server, click the three-dots menu and select **Uninstall**. This deletes the connection record, closes the runtime connection, and unregisters all its tools. This action is **destructive** -- the configuration is permanently removed, not soft-deleted.

---

## Enable/Disable Management

Manage all your installed MCP connections from the Settings page.

### Finding Your Connections

Navigate to **Settings > MCP Connections** — the MCP Connections sub-section of the Settings page (`/settings?section=mcpConnections`, on the Advanced tab). It shows all MCP connections in the system (the `GET /mcp-connections/statuses` endpoint applies no workspace filter), including both marketplace-installed and manually created ones.

### Connection Table

| Column | Description |
|--------|-------------|
| **Name** | The connection's display name |
| **URL / Transport** | The server URL for SSE (`sse`) or streamable HTTP (`streamable-http`) transport — these are the only two transport types offered in the UI (stdio is excluded from the UI) |
| **Status** | Live indicator: green dot (connected), gray dot (disconnected), red dot (error) |
| **Enabled** | Toggle switch to enable or disable the connection |
| **Actions** | Test, Edit, Delete buttons |

### Enabling and Disabling

Toggle the switch next to a connection to enable or disable it:
- **Enabled**: The runtime connection activates and tools become available to the AI assistant.
- **Disabled**: The runtime connection closes and tools are unregistered, but the configuration stays in the database. You can re-enable it at any time.

### Live Status

Connection status updates automatically every 30 seconds (the table polls on a 30-second interval). Status meanings:
- **Green (connected)**: Connection is active and tools are available.
- **Gray (disconnected)**: Connection is disabled or never successfully connected.
- **Red (error)**: Connection attempt failed. The indicator has no tooltip — run the Test action to see the specific error details.

### Testing a Connection

Click the **Test** text link button next to a connection. The system disconnects, reconnects, and reports the result:
- **Success**: A gray badge (`text-secondary-foreground`) appears with the number of tools discovered.
- **Failure**: A red badge appears with the error message. The test has a 10-second timeout.

Testing is useful for verifying that a server is reachable and has the expected tools.

### Editing a Connection

Click the **Edit** text link button to open a form pre-populated with the current values. You can change the URL, name, or transport type. If the connection is currently enabled, editing it triggers an automatic disconnect and reconnect with the new configuration.

### Deleting a Connection

Click the **Delete** text link button and confirm in the dialog. This deletes the database record, closes the runtime connection, and unregisters all its skills. This action cannot be undone.

---

## Per-Chat Pinning

Pinning lets you control which MCP tools are available in a specific chat session, overriding the workspace-wide defaults.

### Why Use Pinning

By default, all enabled MCP connections in your workspace make their tools available to every chat. Pinning restricts a specific chat to only use certain connections' tools. This is useful for:
- Focused conversations where you do not want the AI using unnecessary tools.
- Limiting tool access for sensitive or narrow-scope discussions.
- Testing how the AI behaves with a specific subset of tools.

### Opening the Pinner

Click the MCP icon (lightning bolt) in the right console panel (RightPanel), next to the chat area. A dropdown popover opens, listing all MCP connections installed in the current workspace.

### The Pinner Interface

Each connection shows:
- **Connection name** -- the display name of the MCP server.
- **Status dot** -- burnt orange (connected, `variant="default"`, `bg-primary` #973C00), beige (disconnected, `variant="secondary"`, `bg-secondary` #EDE6DB in the light theme; dark gray in the dark theme), or red (error).
- **Toggle switch** -- slide to pin or unpin.

### Pinning a Connection

Toggle the switch **ON** to pin a connection for this chat. When at least one connection is pinned, the pinned (and enabled) connections' tools are included — but unpinned connections that are active and connected still provide their tools as well, because the workspace-scoped MCP tool union is strictly additive and never removes them.

### Unpinning a Connection

Toggle the switch **OFF** to unpin. Unpinning does not remove the connection's tools from this chat: the workspace-scoped MCP tool union re-adds registry skills for any active+connected connection, so the unpinned connection's tools remain available in the chat.

### Removing All Pins

If you unpin every connection, the system reverts to the default behavior: all workspace-enabled connections provide tools. This is equivalent to having no pinner restrictions.

### Persistence

Pins survive page reloads, server restarts, and browser sessions. They are stored per-chat in the database and persist indefinitely until you change them.

### Optimistic UI

The toggle updates immediately for a snappy experience. The API call to persist your change runs in the background. If the API call fails, the toggle reverts to its previous state and an error toast appears.

### Empty State

If your workspace has no installed MCP connections, the pinner shows: "No MCP connections installed in this workspace" with a link to open the marketplace.

---

## Troubleshooting

Below are common problems you may encounter and how to resolve them. Each entry follows a symptom, probable cause, and fix format.

| Symptom | Probable Cause | Fix |
|---------|---------------|-----|
| **"Test failed" error** -- A red error dot appears on a connection, or the Test button returns "Test failed: {{error}}" (i18n key `settings.mcpConnections.testFailed`). | The MCP server URL is incorrect, the server is not running, a network or firewall blocks the connection, or the server requires authentication headers that are not provided. | Verify the URL is correct (check for typos, missing `/sse` path). Ensure the MCP server is running and reachable from your Simmetric Chat server. If the server requires authentication headers, add them via the Edit form. Use the Test button to get the specific error message — the server test route returns error strings such as "Connection test timed out after 10 seconds". |
| **Server marked as "stale" or "down"** -- A catalog entry shows a beige "stale" or red "down" health badge, or the "last verified" timestamp is old. The "stale" badge uses `variant="secondary"` (beige `bg-secondary` #EDE6DB with a brown `bg-secondary-foreground` #5C4A3D dot in the light theme; dark gray in the dark theme). | The MCP server's public endpoint is temporarily unreachable, the server has been decommissioned, or there are network connectivity issues. | Wait for the next health-check cycle (every 30 minutes) -- the status updates automatically. Note that the Test button in MCP Connections verifies connection reachability but does NOT update the catalog health badge. If the server stays "down" through multiple cycles, its URL may have changed or it may have been shut down. |
| **Install button is disabled** -- The Install button is grayed out and shows a tooltip: "Select a workspace to install". | No workspace is currently selected in the workspace switcher. | Use the workspace switcher in the sidebar to select an active workspace. If you do not have a workspace, create one via **Create Workspace** in the sidebar. The marketplace requires a workspace context to install connections. |
| **Tools not appearing in chat** -- You installed an MCP connection and it shows as "connected" (green), but the AI does not use or suggest its tools when you send a message. | The connection's tools may be disabled in settings, the chat may have active pins that exclude this connection, the connection may be connected but discovered zero tools, the AI model may not need tools for your specific query, or the connection may be installed in a different workspace. | Check the MCP Connections settings tab: verify the connection is enabled and has a tool count greater than zero. Open the pinner popover in the right console panel and verify this connection is pinned (if other connections are pinned, unpinned ones are excluded). Use the Test button to confirm tool discovery. Ensure you are in the correct workspace. Try asking a question that would explicitly require those tools. |

---

## Further Help

For technical documentation, see [DEVELOPMENT.md](DEVELOPMENT.md) and [ARCHITECTURE.md](ARCHITECTURE.md). For API-level details, visit the interactive Swagger documentation at `/api-docs` when the server is running or browse [API.md](API.md).

Return to the [documentation index](INDEX.md) or the [main README](../README.md) for an overview of all Simmetric Chat features.
