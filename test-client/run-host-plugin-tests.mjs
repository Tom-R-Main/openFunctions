import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLocalFixtureBindings } from '../dist/src/framework/work/index.js';
import mixed from '../plugins/openclaw-execufunction/dist/index.js';
import staticPlugin from '../plugins/openclaw-openfunctions/dist/index.js';

function load(plugin, config = {}) {
  const tools = [], services = [];
  plugin.register({ config, registerTool(tool) { tools.push(tool); }, registerService(service) { services.push(service); } });
  return { tools, services };
}

test('actual OpenClaw static SDK factory loads and preserves known success / failure calls', async () => {
  const { tools } = load(staticPlugin);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['of_calculate', 'of_convert_units']);
  const tool = tools.find((tool) => tool.name === 'of_calculate');
  const result = await tool.execute('sdk-success', { a: 8, b: 2, operator: 'divide' });
  assert.match(JSON.stringify(result), /4/);
  await assert.rejects(tool.execute('sdk-failure', { a: 8, b: 0, operator: 'divide' }), /division by zero/);
  await assert.rejects(tool.execute('sdk-validation', { a: 8, b: 0 }), /operator/);
});

test('mixed OpenClaw SDK registration is credential-free, excludes unsupported hosted sessions, and exposes local work separately', async () => {
  const tokenNames = ['SIFT_TOKEN', 'SIFT_PAT', 'EXF_TOKEN', 'EXF_PAT'];
  const saved = Object.fromEntries(tokenNames.map((name) => [name, process.env[name]]));
  for (const name of tokenNames) delete process.env[name];
  try {
    const { tools } = load(mixed);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    assert.ok(tools.some((tool) => tool.name === 'of_work_start'));
    assert.ok(tools.every((tool) => !tool.name.startsWith('work_session_')));
    const tool = tools.find((tool) => tool.name === 'of_work_start');
    const result = await tool.execute('no-profile', { workItemId: 'job' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /workConfigPath|OPENFUNCTION_WORK_CONFIG/);
  } finally {
    for (const name of tokenNames) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});

for (const staleSubject of [false, true]) test(staleSubject
  ? 'actual OpenClaw native completion refuses a subject changed after verification'
  : 'actual OpenClaw native calls complete a bounded local job with CLI-issued grants and fresh proof', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openfunction-openclaw-')); chmodSync(root, 0o700);
  let activeServices = [];
  t.after(async () => { for (const service of activeServices) await service.stop?.(); rmSync(root, { recursive: true, force: true }); });
  const fixture = join(root, 'fixture.json'), verifier = join(root, 'verify.mjs'), configPath = join(root, 'profile.json'), previewPath = join(root, 'preview.json');
  writeFileSync(fixture, '{"status":"needs_correction","value":0}\n', { mode: 0o600 });
  writeFileSync(verifier, 'import fs from "node:fs";const x=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(x.value!==1||x.status!=="corrected")process.exit(1);console.log("verified");\n', { mode: 0o600 });
  const binding = createLocalFixtureBindings({ workspaceRoot: root, fixturePath: 'fixture.json', verifierPath: 'verify.mjs' });
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1, workspaceRoot: root, dataDir: join(root, 'data'), grantDir: join(root, 'grants'),
    backend: { kind: 'local', backendId: 'openclaw-test', workspaceId: 'offline-workspace', workItems: [{ workItemId: 'job', contract: binding.contract, plan: { id: 'plan', version: 1, state: 'active', steps: [binding.verificationStep] } }] },
    stepCatalog: { kind: 'fixture', fixturePath: 'fixture.json', verifierPath: 'verify.mjs' },
  }), { mode: 0o600 });
  const cli = resolve('dist/src/cli.js');
  execFileSync(process.execPath, [cli, 'work', 'prepare', '--config', configPath, '--work-item', 'job', '--out', previewPath]);
  const authorization = execFileSync(process.execPath, [cli, 'work', 'authorize', '--config', configPath, '--preview', previewPath], { input: 'AUTHORIZE\nCOMPLETE\n', encoding: 'utf8' });
  assert.match(authorization, /"automaticCompletion":\s*true/);
  const { tools, services } = load(mixed, { plugins: { entries: { execufunction: { config: { workConfigPath: configPath } } } } });
  activeServices = services;
  let callCount = 0;
  const call = async (name, params = {}) => {
    const result = await tools.find((tool) => tool.name === name).execute(`native-${++callCount}-${name}`, params);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.details?.executionReceipt.executionId);
    return result.details.result.data;
  };
  await call('of_work_start', { workItemId: 'job' });
  const inspected = await call('of_work_step', { stepKey: 'inspect', params: {} });
  assert.equal(inspected.result.success, true);
  await call('of_work_step', { stepKey: 'correct', params: { expectedDigest: inspected.result.data.expectedDigest } });
  const evidence = await call('of_work_verify', { stepId: 'fixture-check' });
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.readbackPassed, true);
  if (staleSubject) writeFileSync(fixture, '{"status":"needs_correction","value":0}\n');
  assert.equal((await call('of_work_finish')).state, staleSubject ? 'needs_review' : 'completed');
  assert.equal(JSON.parse(readFileSync(fixture, 'utf8')).value, staleSubject ? 0 : 1);
});

test('actual pinned Pi loader accepts the packaged extension and executes its native contract', async (t) => {
  const { discoverAndLoadExtensions } = await import('../plugins/pi-openfunctions/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = mkdtempSync(join(tmpdir(), 'openfunction-pi-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve('plugins/pi-openfunctions/src/index.ts')], root, join(root, 'agent'));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tool = loaded.extensions[0].tools.get('of_add').definition;
  const result = await tool.execute('pi-native-success', { a: 2, b: 3 }, undefined, undefined, {});
  assert.deepEqual(result.details.data, { result: 5 });
  assert.equal(result.details.executionReceipt.callId, 'pi-native-success');
  await assert.rejects(tool.execute('pi-native-validation', { a: 2 }, undefined, undefined, {}), /b/);
});
