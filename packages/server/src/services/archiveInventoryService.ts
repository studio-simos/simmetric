// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../utils/logger";
import { appendToLog } from "./archiveLogService";

const VALID_CATEGORIES = ["entities", "questions", "tasks", "watch"] as const;
type InventoryCategory = (typeof VALID_CATEGORIES)[number];

interface InventoryItem {
  id: string;
  name: string;
  status: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface AddInventoryItemInput {
  name: string;
  status?: string;
  notes?: string;
}

interface UpdateInventoryItemInput {
  name?: string;
  status?: string;
  notes?: string;
}

interface PreviewChange {
  action: "add" | "update" | "delete";
  itemId?: string;
  data?: Record<string, unknown>;
}

interface PreviewResult {
  before: { itemCount: number; items: InventoryItem[] };
  after: { itemCount: number; items: InventoryItem[] };
  changes: { added: number; updated: number; deleted: number };
}

function validateCategory(category: string): asserts category is InventoryCategory {
  if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(
      `Invalid inventory category: "${category}". Must be one of: ${VALID_CATEGORIES.join(", ")}`
    );
  }
}

function getInventoryPath(archiveSlug: string, category: string): string {
  validateCategory(category);
  return path.resolve(
    process.cwd(),
    "storage/archives",
    archiveSlug,
    "inventory",
    `${category}.md`
  );
}

const CATEGORY_HEADINGS: Record<InventoryCategory, string> = {
  entities: "Entities",
  questions: "Questions",
  tasks: "Tasks",
  watch: "Watch",
};

function buildFileContent(
  category: InventoryCategory,
  items: InventoryItem[]
): string {
  const now = new Date().toISOString();
  const heading = CATEGORY_HEADINGS[category];

  const rows = items.map(
    (item) =>
      `| ${item.id} | ${item.name} | ${item.status} | ${item.notes} | ${item.createdAt} | ${item.updatedAt} |`
  );

  return [
    `# ${heading}`,
    "",
    `_Last updated: ${now}_`,
    "",
    "| ID | Name | Status | Notes | Created | Updated |",
    "|----|------|--------|-------|---------|---------|",
    ...rows,
    "",
  ].join("\n");
}

function parseInventoryFile(content: string): InventoryItem[] {
  const lines = content.split("\n");
  const items: InventoryItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    // Skip the header row and separator line
    if (
      trimmed.startsWith("| ID ") ||
      trimmed.startsWith("|----")
    )
      continue;

    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

    if (cells.length >= 6) {
      items.push({
        id: cells[0]!,
        name: cells[1]!,
        status: cells[2]!,
        notes: cells[3]!,
        createdAt: cells[4]!,
        updatedAt: cells[5]!,
      });
    }
  }

  return items;
}

/**
 * Add a new item to an inventory category.
 *
 * If the inventory file does not exist, it is created with the header and table structure.
 * Returns the newly created item with its generated UUID.
 */
export async function addInventoryItem(
  archiveSlug: string,
  category: string,
  item: AddInventoryItemInput
): Promise<InventoryItem> {
  validateCategory(category);
  const filePath = getInventoryPath(archiveSlug, category);
  const now = new Date().toISOString();

  const newItem: InventoryItem = {
    id: uuidv4(),
    name: item.name,
    status: item.status || "active",
    notes: item.notes || "",
    createdAt: now,
    updatedAt: now,
  };

  let existingItems: InventoryItem[] = [];
  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    existingItems = parseInventoryFile(fileContent);
  } catch {
    // File doesn't exist — will be created
  }

  const updatedItems = [...existingItems, newItem];
  const newFileContent = buildFileContent(category as InventoryCategory, updatedItems);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, newFileContent, "utf-8");

  try {
    await appendToLog(archiveSlug, {
      source: "system",
      change: `inventory:add ${category}`,
      description: `Added "${item.name}" to ${category}`,
    });
  } catch (logErr: unknown) {
  const message = logErr instanceof Error ? logErr.message : String(logErr);
    logger.warn("[archive] Failed to log inventory add", {
      archive: archiveSlug,
      category,
      error: logErr instanceof Error ? message : String(logErr),
    });
  }

  logger.info("[archive] Inventory item added", {
    archive: archiveSlug,
    category,
    itemId: newItem.id,
  });

  return newItem;
}

/**
 * Retrieve all items from an inventory category.
 */
export async function getInventoryItems(
  archiveSlug: string,
  category: string
): Promise<InventoryItem[]> {
  validateCategory(category);
  const filePath = getInventoryPath(archiveSlug, category);

  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    return parseInventoryFile(fileContent);
  } catch {
    // File doesn't exist — return empty array
    return [];
  }
}

/**
 * Update an existing inventory item by ID.
 *
 * Only the provided fields are updated; omitted fields keep their current values.
 * The `updatedAt` timestamp is always set to the current time.
 */
export async function updateInventoryItem(
  archiveSlug: string,
  category: string,
  itemId: string,
  updates: UpdateInventoryItemInput
): Promise<InventoryItem> {
  validateCategory(category);
  const filePath = getInventoryPath(archiveSlug, category);

  let fileContent: string;
  try {
    fileContent = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Inventory file not found: ${category}.md`);
  }

  const items = parseInventoryFile(fileContent);
  const index = items.findIndex((item) => item.id === itemId);

  if (index === -1) {
    throw new Error(`Inventory item not found: ${itemId}`);
  }

  const existingItem = items[index]!;
  const now = new Date().toISOString();
  items[index] = {
    ...existingItem,
    name: updates.name ?? existingItem.name,
    status: updates.status ?? existingItem.status,
    notes: updates.notes ?? existingItem.notes,
    updatedAt: now,
  };

  const updatedItem = items[index]!;
  const newFileContent = buildFileContent(category as InventoryCategory, items);
  await fs.writeFile(filePath, newFileContent, "utf-8");

  try {
    await appendToLog(archiveSlug, {
      source: "system",
      change: `inventory:update ${category}`,
      description: `Updated "${updatedItem.name}" in ${category}`,
    });
  } catch (logErr: unknown) {
  const message = logErr instanceof Error ? logErr.message : String(logErr);
    logger.warn("[archive] Failed to log inventory update", {
      archive: archiveSlug,
      category,
      error: logErr instanceof Error ? message : String(logErr),
    });
  }

  logger.info("[archive] Inventory item updated", {
    archive: archiveSlug,
    category,
    itemId,
  });

  return items[index]!;
}

/**
 * Delete an inventory item by ID.
 *
 * Removes the matching row from the Markdown table and rewrites the file.
 */
export async function deleteInventoryItem(
  archiveSlug: string,
  category: string,
  itemId: string
): Promise<{ message: string }> {
  validateCategory(category);
  const filePath = getInventoryPath(archiveSlug, category);

  let fileContent: string;
  try {
    fileContent = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Inventory file not found: ${category}.md`);
  }

  const items = parseInventoryFile(fileContent);
  const deletedItem = items.find((item) => item.id === itemId);

  if (!deletedItem) {
    throw new Error(`Inventory item not found: ${itemId}`);
  }

  const filteredItems = items.filter((item) => item.id !== itemId);
  const newFileContent = buildFileContent(category as InventoryCategory, filteredItems);
  await fs.writeFile(filePath, newFileContent, "utf-8");

  try {
    await appendToLog(archiveSlug, {
      source: "system",
      change: `inventory:delete ${category}`,
      description: `Deleted "${deletedItem.name}" from ${category}`,
    });
  } catch (logErr: unknown) {
  const message = logErr instanceof Error ? logErr.message : String(logErr);
    logger.warn("[archive] Failed to log inventory delete", {
      archive: archiveSlug,
      category,
      error: logErr instanceof Error ? message : String(logErr),
    });
  }

  logger.info("[archive] Inventory item deleted", {
    archive: archiveSlug,
    category,
    itemId,
  });

  return { message: "Item deleted" };
}

/**
 * Preview the result of proposed inventory changes without writing to disk.
 *
 * This is a dry-run function that simulates additions, updates, and deletions
 * in memory and returns the before/after state for review. Zero filesystem mutations.
 */
export async function previewInventoryChanges(
  archiveSlug: string,
  category: string,
  proposedChanges: PreviewChange[]
): Promise<PreviewResult> {
  validateCategory(category);

  const beforeItems = await getInventoryItems(archiveSlug, category);

  // Clone items for in-memory simulation
  let simulatedItems = beforeItems.map((item) => ({ ...item }));
  const stats = { added: 0, updated: 0, deleted: 0 };

  for (const change of proposedChanges) {
    switch (change.action) {
      case "add": {
        const now = new Date().toISOString();
        const newItem: InventoryItem = {
          id: uuidv4(),
          name: String(change.data?.name || ""),
          status: String(change.data?.status || "active"),
          notes: String(change.data?.notes || ""),
          createdAt: now,
          updatedAt: now,
        };
        simulatedItems.push(newItem);
        stats.added++;
        break;
      }
      case "update": {
        if (!change.itemId) break;
        const idx = simulatedItems.findIndex((item) => item.id === change.itemId);
        if (idx === -1) break;
        const simItem = simulatedItems[idx]!;
        const now = new Date().toISOString();
        simulatedItems[idx] = {
          ...simItem,
          name: change.data?.name !== undefined ? String(change.data.name) : simItem.name,
          status: change.data?.status !== undefined ? String(change.data.status) : simItem.status,
          notes: change.data?.notes !== undefined ? String(change.data.notes) : simItem.notes,
          updatedAt: now,
        };
        stats.updated++;
        break;
      }
      case "delete": {
        if (!change.itemId) break;
        const before = simulatedItems.length;
        simulatedItems = simulatedItems.filter((item) => item.id !== change.itemId);
        if (simulatedItems.length < before) stats.deleted++;
        break;
      }
    }
  }

  return {
    before: {
      itemCount: beforeItems.length,
      items: beforeItems,
    },
    after: {
      itemCount: simulatedItems.length,
      items: simulatedItems,
    },
    changes: stats,
  };
}
