#!/usr/bin/env node

/**
 * Generate an API key for the widget system.
 *
 * Usage:
 *   node scripts/generate-widget-apikey.js                    # interactive
 *   node scripts/generate-widget-apikey.js --name "My Widget" # with name
 *   node scripts/generate-widget-apikey.js --list              # list existing keys
 *   node scripts/generate-widget-apikey.js --revoke <keyId>    # revoke a key
 *   node scripts/generate-widget-apikey.js --expires 30       # expires in 30 days
 *
 * Must be run from packages/server/ directory.
 * Requires DATABASE_URL in .env (loaded by Prisma).
 */

const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcryptjs");
const path = require("path");

// Load the repo-root .env (marker-walk via ../../..; cwd-adjacent fallback).
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SALT_ROUNDS = 12;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { name: "", list: false, revoke: "", expiresDays: 0 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) opts.name = args[++i];
    if (args[i] === "--list") opts.list = true;
    if (args[i] === "--revoke" && args[i + 1]) opts.revoke = args[++i];
    if (args[i] === "--expires" && args[i + 1]) opts.expiresDays = parseInt(args[++i], 10);
  }

  return opts;
}

async function findAdminUser() {
  const admin = await prisma.user.findFirst({
    where: {
      roles: {
        some: {
          role: {
            name: { in: ["admin", "superuser"] },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, email: true },
  });

  if (!admin) {
    console.error("No admin user found. Create an admin user first via the setup wizard.");
    process.exit(1);
  }

  return admin;
}

async function generateKey(name, expiresDays) {
  const admin = await findAdminUser();
  const keyName = name || `widget-key-${Date.now()}`;

  // Generate the key: sk-<32-hex-chars>
  const rawKey = `sk-${uuidv4().replace(/-/g, "")}`;
  const hashedKey = await bcrypt.hash(rawKey, SALT_ROUNDS);

  const expiresAt = expiresDays > 0
    ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
    : null;

  const apiKey = await prisma.apiKey.create({
    data: {
      name: keyName,
      hashedKey,
      createdBy: admin.id,
      expiresAt,
    },
  });

  console.log("\n=== Widget API Key Generated ===\n");
  console.log(`  ID:          ${apiKey.id}`);
  console.log(`  Name:        ${keyName}`);
  console.log(`  Created by:  ${admin.username} (${admin.email})`);
  console.log(`  Expires:     ${expiresAt ? expiresAt.toISOString() : "Never"}`);
  console.log(`  Created at:  ${apiKey.createdAt.toISOString()}`);
  console.log("\n  API Key (save this now — it won't be shown again):");
  console.log(`  ${rawKey}`);
  console.log("\n=== Usage in Widget ===");
  console.log("  Header:  X-Api-Key: <your-key>");
  console.log("  Example: curl -H 'X-Api-Key: <your-key>' http://localhost:3000/api/internal/widget/<widget-id>/config");
  console.log("");
}

async function listKeys() {
  const admin = await findAdminUser();
  const keys = await prisma.apiKey.findMany({
    where: { createdBy: admin.id },
    select: {
      id: true,
      name: true,
      lastUsed: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (keys.length === 0) {
    console.log("\nNo API keys found for admin user.\n");
    return;
  }

  console.log(`\n=== API Keys for ${admin.username} (${keys.length}) ===\n`);
  for (const k of keys) {
    const expired = k.expiresAt && k.expiresAt < new Date() ? " [EXPIRED]" : "";
    const lastUsed = k.lastUsed ? k.lastUsed.toISOString() : "Never";
    console.log(`  ${k.name}${expired}`);
    console.log(`    ID:        ${k.id}`);
    console.log(`    Created:   ${k.createdAt.toISOString()}`);
    console.log(`    Last used: ${lastUsed}`);
    console.log(`    Expires:   ${k.expiresAt ? k.expiresAt.toISOString() : "Never"}`);
    console.log("");
  }
}

async function revokeKey(keyId) {
  const key = await prisma.apiKey.findFirst({ where: { id: keyId } });
  if (!key) {
    console.error(`API key not found: ${keyId}`);
    process.exit(1);
  }

  await prisma.apiKey.delete({ where: { id: keyId } });
  console.log(`\nAPI key revoked: ${key.name} (${keyId})\n`);
}

async function main() {
  const opts = parseArgs();

  try {
    if (opts.revoke) {
      await revokeKey(opts.revoke);
    } else if (opts.list) {
      await listKeys();
    } else {
      await generateKey(opts.name, opts.expiresDays);
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();