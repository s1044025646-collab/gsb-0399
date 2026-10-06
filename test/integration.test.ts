import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { startBwtServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), 'dist', 'cli.js');

async function runCli(args: string[], cwd = process.cwd()) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

test('CLI persists transform, pages rotations, queries LF, and decodes after source deletion', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bwt-cli-'));
  const dataDir = join(temp, 'data');
  const inputPath = join(temp, 'input.bin');
  const exportPath = join(temp, 'export.json');
  const restoredPath = join(temp, 'restored.bin');
  const original = Buffer.from([0, 65, 0, 255, 66, 98, 97, 110, 97, 110, 97]);
  await writeFile(inputPath, original);

  try {
    const transformed = await runCli(['transform', '--file', inputPath, '--data-dir', dataDir]);
    const transformRecord = JSON.parse(transformed.stdout) as { id: string; primary: number };

    const rotations = await runCli(['rotations', transformRecord.id, '--limit', '3', '--offset', '1', '--data-dir', dataDir]);
    const rotationPage = JSON.parse(rotations.stdout) as { total: number; limit: number; offset: number; rows: unknown[] };
    assert.equal(rotationPage.total, original.length);
    assert.equal(rotationPage.limit, 3);
    assert.equal(rotationPage.offset, 1);
    assert.equal(rotationPage.rows.length, 3);

    const lf = await runCli(['lf', transformRecord.id, '--row', '0', '--data-dir', dataDir]);
    const lfRecord = JSON.parse(lf.stdout) as { row: number; nextRow: number };
    assert.equal(lfRecord.row, 0);
    assert.ok(Number.isSafeInteger(lfRecord.nextRow));

    await runCli(['export', transformRecord.id, '--output', exportPath, '--data-dir', dataDir]);
    await rm(inputPath);

    const freshData = join(temp, 'fresh-data');
    const imported = await runCli(['import', '--export', exportPath, '--data-dir', freshData]);
    const importedRecord = JSON.parse(imported.stdout) as { id: string; digestMatches: boolean };
    assert.equal(importedRecord.digestMatches, true);

    const standalone = await runCli(['inverse', '--export', exportPath, '--output', restoredPath]);
    assert.match(standalone.stderr, /digestMatches=true/);
    assert.deepEqual(await readFile(restoredPath), original);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('HTTP API transforms, exports, imports standalone JSON, and verifies digest', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bwt-http-'));
  const running = await startBwtServer({ port: 0, dataDir: join(temp, 'data'), maxBlockBytes: 4096 });
  try {
    const transformResponse = await fetch(`http://127.0.0.1:${running.port}/v1/blocks/transform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'utf8', value: 'banana' }),
    });
    assert.equal(transformResponse.status, 201);
    const transformed = await transformResponse.json() as {
      id: string;
      length: number;
      primary: number;
      L: { base64: string };
    };
    assert.equal(transformed.length, 6);
    assert.equal(transformed.primary, 3);

    const exportResponse = await fetch(`http://127.0.0.1:${running.port}/v1/blocks/${transformed.id}/export`);
    assert.equal(exportResponse.status, 200);
    const exported = await exportResponse.json();

    const importResponse = await fetch(`http://127.0.0.1:${running.port}/v1/exports/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exported),
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json() as { digestMatches: boolean };
    assert.equal(imported.digestMatches, true);

    const badPrimaryResponse = await fetch(`http://127.0.0.1:${running.port}/v1/blocks/${transformed.id}/lf?row=99`);
    assert.equal(badPrimaryResponse.status, 400);
    const badPrimary = await badPrimaryResponse.json() as { error: { code: string } };
    assert.equal(badPrimary.error.code, 'INVALID_PRIMARY');
  } finally {
    await running.close();
    await rm(temp, { recursive: true, force: true });
  }
});
