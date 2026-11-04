#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { remoteFiles, REMOTE_API_ORIGIN } from '../src/remote-site.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/build-remote-site.js <output-directory>');
const output = resolve(destination);
await mkdir(output, { recursive: true });
const files = remoteFiles();
for (const [name, content] of Object.entries(files)) await writeFile(join(output, name), content);
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
await writeFile(join(output, 'build.json'), JSON.stringify({ source_commit: source, api_origin: REMOTE_API_ORIGIN,
  sha256: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])) }, null, 2) + '\n');
console.log('Built private /remote/ viewer; API: ' + REMOTE_API_ORIGIN);
