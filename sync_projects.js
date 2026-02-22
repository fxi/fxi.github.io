#!/usr/bin/env node
/**
 * sync_projects.js
 * Reads all ../projects/<project>/project.json files and writes
 * astro/src/data/projects.json for use at build time.
 *
 * Usage:  node sync_projects.js
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const projectsDir = resolve(__dir, 'projects');
const outFile = resolve(__dir, 'src', 'data', 'projects.json');

const entries = readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => {
    const jsonPath = join(projectsDir, d.name, 'project.json');
    if (!existsSync(jsonPath)) return null;
    try {
      return JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch (err) {
      console.warn(`⚠  skipping ${d.name}: ${err.message}`);
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => (b.year_last ?? 0) - (a.year_last ?? 0));

writeFileSync(outFile, JSON.stringify(entries, null, 2) + '\n');
console.log(`✓  wrote ${entries.length} projects → ${outFile}`);
