#!/usr/bin/env node
// Runs node:test files and sends the results to DX O2 as the "test.*" metrics from dxo2-test-dashboard-guide.md (section 1).
// A small reference harness: no dependencies, Node 20 or newer.
//
//   node run-tests-with-otel.mjs --triplet "myhost|MyTests|my-test-agent" --project-root "myproject=C:/repo/projects/myproject" file1 file2 ...
//
// Options
//   --triplet "<host>|<process>|<agent>"   agent name in DX O2 (required)
//   --project-root "<name>=<dir>"          repeatable. A test file inside <dir> is reported as project <name> with a path relative to <dir>,
//                                          and is run with <dir> as its working directory. Files outside every root use their cwd.
//   --endpoint <url>        OTLP/HTTP base URL, default https://otel-gateway.dxi-na1.saas.broadcom.com
//   --token-env <NAME>      env var holding an AGENT token (default DXO2_AGENT_TOKEN). Never pass the token itself.
//   --project-attr <name>   attribute that carries the project name on test.case.duration (default test.project)
//   --slow-ms <n>           send test.case.duration only for tests at least this slow, or failing (default 1000)
//   --concurrency <n>       test files run in parallel (default 4)
//   --service <name>        resource service.name (default test-harness)
//   --dry-run               run the tests and print the metrics; send nothing
//
// Safety: test processes get a throw-away home directory, and every environment variable whose name looks like a secret
// (TOKEN, PASSWORD, SECRET, KEY, COHORT, CREDENTIAL) is removed from their environment.
//
// DX O2 keeps ONE value per series per minute (see the guide, 1.1a): this harness sends exactly one point per series per run.
// Do not start two runs under the same agent within the same minute.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const all = (n) => args.flatMap((a, i) => (a === '--' + n && args[i + 1] ? [args[i + 1]] : []));
const has = (n) => args.includes('--' + n);
const VALUE_FLAGS = new Set(['triplet', 'project-root', 'endpoint', 'token-env', 'project-attr', 'slow-ms', 'concurrency', 'service', 'file-timeout', 'report-top']);
const files = []; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { if (VALUE_FLAGS.has(args[i].slice(2))) i++; continue; } files.push(args[i]); }

const triplet = arg('triplet');
if (!triplet || triplet.split('|').length !== 3) { console.error('--triplet "<host>|<process>|<agent>" is required'); process.exit(2); }
if (!files.length) { console.error('give at least one test file'); process.exit(2); }
const endpoint = arg('endpoint', 'https://otel-gateway.dxi-na1.saas.broadcom.com').replace(/\/$/, '');
const tokenEnv = arg('token-env', 'DXO2_AGENT_TOKEN');
const projectAttr = arg('project-attr', 'test.project');
const SLOW_MS = Number(arg('slow-ms', '1000'));
const CONC = Number(arg('concurrency', '4'));
const FILE_TIMEOUT_MS = Number(arg('file-timeout', '180')) * 1000;   // a test file still running after this is killed (with its child processes) and reported as failed
const REPORT_TOP = Number(arg('report-top', '0'));                    // print the N slowest tests of this run
const service = arg('service', 'test-harness');
const dry = has('dry-run');
const token = process.env[tokenEnv];
if (!dry && !token) { console.error(`environment variable ${tokenEnv} is empty (it must hold an agent token)`); process.exit(2); }

const roots = all('project-root').map((s) => { const i = s.indexOf('='); return { name: s.slice(0, i), dir: path.resolve(s.slice(i + 1)) }; })
  .sort((a, b) => b.dir.length - a.dir.length);
const norm = (p) => p.split(path.sep).join('/');
function describeFile(f) {
  const abs = path.resolve(f);
  const r = roots.find((x) => abs.toLowerCase().startsWith((x.dir + path.sep).toLowerCase()));
  return r ? { abs, project: r.name, cwd: r.dir, suite: norm(path.relative(r.dir, abs)) } : { abs, project: '', cwd: process.cwd(), suite: norm(path.relative(process.cwd(), abs)) };
}

// ---- a throw-away reporter that prints one JSON line per finished test ---------------------------------------------
const work = mkdtempSync(path.join(tmpdir(), 'otel-harness-'));
const home = path.join(work, 'home'); mkdirSync(home, { recursive: true });
const reporter = path.join(work, 'jsonl-reporter.mjs');
writeFileSync(reporter, `export default async function* (source) {
  for await (const e of source) {
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    const d = e.data, det = d.details || {};
    yield JSON.stringify({ r: e.type === 'test:pass' ? 'pass' : 'fail', name: d.name, nesting: d.nesting, kind: det.type || 'test',
      ms: det.duration_ms || 0, skip: Boolean(d.skip), todo: Boolean(d.todo), err: e.type === 'test:fail' ? String((det.error && det.error.message) || '').split('\\n')[0].slice(0, 160) : '' }) + '\\n';
  }
}\n`);

const SECRET = /(TOKEN|PASSWORD|SECRET|KEY|COHORT|CREDENTIAL)/i;
const env = {}; for (const [k, v] of Object.entries(process.env)) if (!SECRET.test(k)) env[k] = v;
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home });

function runFile(f) {
  const info = describeFile(f);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=' + pathToFileURL(reporter).href, info.abs], { cwd: info.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errText = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (errText += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // kill the whole process tree: a hung test may have started children of its own (on Windows child.kill() alone leaves them running)
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL');
    }, FILE_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const leaves = events.filter((e) => e.kind !== 'suite' && !(e.nesting === 0 && e.name && e.name.endsWith(path.basename(info.abs)) && e.r === 'fail' && events.length > 1));
      resolve({ ...info, ms: Date.now() - t0, exit: code, leaves, timedOut, crashed: (code !== 0 || timedOut) && leaves.every((e) => e.r !== 'fail'), stderr: errText.split('\n').find((l) => /Error|error/.test(l)) || '' });
    });
  });
}

// ---- run all files with a small worker pool ------------------------------------------------------------------------
const startedAt = Date.now();
const results = []; let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, async () => { while (next < files.length) { const f = files[next++]; results.push(await runFile(f)); } }));
const wallMs = Date.now() - startedAt;

// ---- roll up -------------------------------------------------------------------------------------------------------
let passed = 0, failed = 0, skipped = 0; const fileRows = []; const cases = new Map(); const allCases = [];
for (const r of results) {
  const p = r.leaves.filter((e) => e.r === 'pass' && !e.skip && !e.todo).length;
  const f = r.leaves.filter((e) => e.r === 'fail').length + (r.crashed ? 1 : 0);
  const s = r.leaves.filter((e) => e.skip || e.todo).length;
  passed += p; failed += f; skipped += s;
  fileRows.push({ suite: r.suite, project: r.project, ms: r.ms, status: f > 0 ? 'failure' : 'success', p, f, s, timedOut: r.timedOut,
    why: r.timedOut ? `still running after ${FILE_TIMEOUT_MS / 1000} s: killed (hung or too slow)` : r.crashed ? (r.stderr || 'process failed before running tests').slice(0, 100) : '' });
  for (const e of r.leaves) {
    if (e.skip || e.todo) continue;
    allCases.push({ suite: r.suite, project: r.project, name: e.name, status: e.r === 'pass' ? 'pass' : 'fail', ms: e.ms });
    if (e.ms < SLOW_MS && e.r === 'pass') continue;                       // only slow or failing tests become test.case.duration points
    const key = [r.project, r.suite, e.name, e.r === 'pass' ? 'pass' : 'fail'].join('\u0001');
    const c = cases.get(key) || { project: r.project, suite: r.suite, name: e.name, status: e.r === 'pass' ? 'pass' : 'fail', ms: 0 };
    c.ms += e.ms; cases.set(key, c);                                      // identical series in one run are summed: one point per series
  }
}

console.log(`ran ${files.length} files in ${(wallMs / 1000).toFixed(1)} s: ${passed} passed, ${failed} failed, ${skipped} skipped; ${fileRows.filter((x) => x.status === 'failure').length} files failed; ${cases.size} case points (>= ${SLOW_MS} ms or failing)`);
for (const x of fileRows.filter((x) => x.status === 'failure').slice(0, 8)) console.log(`  FAILED ${x.suite}  (${x.f} failing${x.why ? ': ' + x.why : ''})`);

if (REPORT_TOP > 0) {
  const top = [...allCases].sort((a, b) => b.ms - a.ms).slice(0, REPORT_TOP);
  console.log(`\nTOP ${top.length} SLOWEST TESTS (this run)`);
  console.log('  #   seconds  result  project    file > test');
  top.forEach((c, i) => console.log(`${String(i + 1).padStart(3)}  ${(c.ms / 1000).toFixed(1).padStart(8)}  ${c.status.padEnd(6)}  ${(c.project || '-').padEnd(9)}  ${c.suite} > ${String(c.name).replace(/\s+/g, ' ').slice(0, 100)}`));
  const hung = fileRows.filter((x) => x.timedOut);
  if (hung.length) { console.log(`\nFILES KILLED AFTER ${FILE_TIMEOUT_MS / 1000} s (hung or too slow, no per-test timing):`); for (const x of hung) console.log(`  ${x.project || '-'}  ${x.suite}`); }
  const bySuite = new Map(); for (const c of allCases) bySuite.set(c.suite, (bySuite.get(c.suite) || 0) + c.ms);
  const heavy = [...bySuite].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log('\nTime is concentrated in: ' + heavy.map(([s, ms]) => `${s} (${(ms / 1000).toFixed(0)} s)`).join(', '));
  console.log('');
}

// ---- build and send the OTLP metrics (ONE request, one point per series) --------------------------------------------
const [host] = triplet.split('|');
const str = (key, v) => ({ key, value: { stringValue: String(v) } });
const t1 = BigInt(Date.now()) * 1000000n, t0 = t1 - BigInt(Math.max(1000, wallMs)) * 1000000n;
const pt = (v, attrs = []) => ({ startTimeUnixNano: String(t0), timeUnixNano: String(t1), asInt: String(Math.max(0, Math.round(v))), attributes: attrs });
const metric = (name, unit, points) => ({ name, unit, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points } });
const metrics = [
  metric('test.run.count', '1', [pt(1)]),
  metric('test.run.tests.passed', '1', [pt(passed)]),
  metric('test.run.tests.failed', '1', [pt(failed)]),
  metric('test.run.tests.skipped', '1', [pt(skipped)]),
  metric('test.run.duration', 'ms', [pt(wallMs)]),
  metric('test.file.duration', 'ms', fileRows.map((x) => pt(x.ms, [str('test.suite.name', x.suite), str('test.suite.run.status', x.status)]))),
];
if (cases.size) metrics.push(metric('test.case.duration', 'ms', [...cases.values()].map((c) => pt(c.ms, [
  str('test.case.name', c.name.slice(0, 200)), str('test.suite.name', c.suite), str('test.case.result.status', c.status), ...(c.project ? [str(projectAttr, c.project)] : [])]))));
const body = { resourceMetrics: [{ resource: { attributes: [str('service.name', service), str('host.name', host), str('broadcomAgentTriplet', triplet)] }, scopeMetrics: [{ scope: { name: 'run-tests-with-otel' }, metrics }] }] };
console.log(`agent ${triplet}: ${metrics.length} metrics, ${metrics.reduce((n, m) => n + m.sum.dataPoints.length, 0)} data points${dry ? '  (dry run, nothing sent)' : ''}`);
writeFileSync(path.join(work, 'last-payload.json'), JSON.stringify(body));
console.log('payload saved at', path.join(work, 'last-payload.json'));
if (dry) process.exit(0);
const res = await fetch(endpoint + '/v1/metrics', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  .catch((e) => ({ status: 'fetch failed: ' + e.message, text: async () => '' }));
console.log('HTTP', res.status, (await res.text()).slice(0, 100));
process.exit(res.status === 200 ? 0 : 1);
