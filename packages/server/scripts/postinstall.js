#!/usr/bin/env node
/**
 * Postinstall script that sets up the bundled @yep-anywhere/shared package.
 *
 * npm ignores node_modules in package tarballs, so we bundle shared in 'bundled/'
 * and create a symlink to it in node_modules after installation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

const bundledShared = path.join(packageRoot, "bundled/@yep-anywhere/shared");
const nodeModulesShared = path.join(
  packageRoot,
  "node_modules/@yep-anywhere/shared",
);

// Only run if bundled directory exists (npm installed package)
if (!fs.existsSync(bundledShared)) {
  // Development mode - workspace symlink already exists
  process.exit(0);
}

// Create node_modules/@yep-anywhere directory if it doesn't exist
const yepAnywhereDir = path.dirname(nodeModulesShared);
if (!fs.existsSync(yepAnywhereDir)) {
  fs.mkdirSync(yepAnywhereDir, { recursive: true });
}

// Remove existing symlink/directory if present
if (fs.existsSync(nodeModulesShared)) {
  const stats = fs.lstatSync(nodeModulesShared);
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(nodeModulesShared);
  } else {
    fs.rmSync(nodeModulesShared, { recursive: true, force: true });
  }
}

// Create symlink to bundled shared package
fs.symlinkSync(bundledShared, nodeModulesShared, "dir");

console.log("[yepanywhere] Linked bundled @yep-anywhere/shared");
