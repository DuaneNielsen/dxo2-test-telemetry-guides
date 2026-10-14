#!/usr/bin/env node
// Sends SAMPLE test results to DX O2 as OTLP/HTTP JSON metrics, using the "test.*" metric contract from
// dxo2-test-dashboard-guide.md (section 1). It is the plain-fetch equivalent of the emitter in that section,
// so you can fill the Test Time dashboard with data before your real harness is wired up.
//
//   node send-sample-test-metrics.mjs --triplet "myhost|TestHarness|sample-runs" [options]
//
// Options
//   --triplet "<host>|<process>|<agent>"   agent name to create in DX O2 (required; use a NEW name, not a real agent)
//   --endpoint <url>      OTLP/HTTP base URL, default https://otel-gateway.dxi-na1.saas.broadcom.com
//   --token-env <NAME>    environment variable that holds an AGENT token (default DXO2_AGENT_TOKEN). Never pass the token itself.
//   --service <name>      resource service.name, default sample-app-tests
//   --runs <n>            number of runs to send, default 6
//   --interval-seconds <n>  pause between runs, default 65 (must be more than 60, see below)
//   --project <name>      adds a test.project attribute to test.case.duration (optional)
//   --dry-run             print what would be sent; send nothing
//
// WHY THE PAUSE: DX O2 keeps ONE value per series per minute. If several points of the same series arrive in the same
// minute it stores "number of points x the LAST value", not their sum, and it ignores recent payload timestamps
// (verified against a live tenant). So send each run in real time, at least a minute apart, one point per series.
//
// All values are made up (deterministic), and every file name starts with tests/sample/ so nobody mistakes them for real data.
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const triplet = arg('triplet');
if (!triplet || triplet.split('|').length !== 3) { console.error('--triplet "<host>|<process>|<agent>" is required'); process.exit(2); }
const endpoint = arg('endpoint', 'https://otel-gateway.dxi-na1.saas.broadcom.com').replace(/\/$/, '');
const tokenEnv = arg('token-env', 'DXO2_AGENT_TOKEN');
const service = arg('service', 'sample-app-tests');
const RUNS = Number(arg('runs', '6'));
const INTERVAL_MS = Number(arg('interval-seconds', '65')) * 1000;
const project = arg('project');
const dry = has('dry-run');
const token = process.env[tokenEnv];
if (!dry && !token) { console.error(`environment variable ${tokenEnv} is empty (it must hold an agent token)`); process.exit(2); }
if (INTERVAL_MS < 61000) { console.error('--interval-seconds must be more than 60 (one point per series per minute)'); process.exit(2); }

// tiny deterministic random numbers, so reruns produce the same shapes
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const jitter = (base, pct) => Math.max(1, Math.round(base * (1 + (rnd() * 2 - 1) * pct)));

const FILES = [
  { path: 'tests/sample/auth.test.js', ms: 900, tests: 14 }, { path: 'tests/sample/cart.test.js', ms: 1800, tests: 22 },
  { path: 'tests/sample/checkout.test.js', ms: 5200, tests: 18 }, { path: 'tests/sample/search.test.js', ms: 2600, tests: 31 },
  { path: 'tests/sample/profile.test.js', ms: 700, tests: 9 }, { path: 'tests/sample/billing.test.js', ms: 4300, tests: 16 },
  { path: 'tests/sample/notifications.test.js', ms: 1200, tests: 11 }, { path: 'tests/sample/export.test.js', ms: 3400, tests: 8 },
];
const SLOW_CASES = [   // only tests above the time threshold are sent (strategy in Part 1)
  { file: 'tests/sample/checkout.test.js', name: 'completes an order with three payment retries', ms: 3100 },
  { file: 'tests/sample/billing.test.js', name: 'reconciles a month of invoices', ms: 2700 },
  { file: 'tests/sample/export.test.js', name: 'exports 10k rows to CSV', ms: 2300 },
  { file: 'tests/sample/search.test.js', name: 'ranks results across 50 filters', ms: 1500 },
  { file: 'tests/sample/cart.test.js', name: 'merges guest and account carts', ms: 1200 },
];

const str = (key, v) => ({ key, value: { stringValue: String(v) } });
const intPoint = (value, attrs, t0, t1) => ({ startTimeUnixNano: String(t0), timeUnixNano: String(t1), asInt: String(Math.round(value)), attributes: attrs });
const metric = (name, unit, points) => ({ name, unit, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points } });   // 1 = DELTA

const [host] = triplet.split('|');
const resource = { attributes: [str('service.name', service), str('host.name', host), str('broadcomAgentTriplet', triplet)] };

// Builds the metrics for ONE run, stamped with the time it is sent.
function buildRun(r) {
  const t1 = BigInt(Date.now()) * 1000000n;
  const t0 = t1 - 50000000000n;                                // the run "took" under a minute of wall time
  const failing = r === RUNS - 1 ? 'tests/sample/checkout.test.js' : (r === 2 ? 'tests/sample/billing.test.js' : null);
  let passed = 0, failed = 0, totalMs = 0; const pts = { file: [], slow: [] };
  for (const f of FILES) {
    const ms = jitter(f.ms, 0.25), bad = f.path === failing;
    const nFailed = bad ? 2 : 0;
    failed += nFailed; passed += f.tests - nFailed; totalMs += ms;
    pts.file.push(intPoint(ms, [str('test.suite.name', f.path), str('test.suite.run.status', bad ? 'failure' : 'success')], t0, t1));
  }
  for (const c of SLOW_CASES) {
    const attrs = [str('test.case.name', c.name), str('test.suite.name', c.file),
                   str('test.case.result.status', c.file === failing && c.name.startsWith('completes') ? 'fail' : 'pass')];
    if (project) attrs.push(str('test.project', project));
    pts.slow.push(intPoint(jitter(c.ms, 0.2), attrs, t0, t1));
  }
  const one = (v) => [intPoint(v, [], t0, t1)];
  return { totals: { passed, failed, totalMs, failing },
    body: { resource, scopeMetrics: [{ scope: { name: 'sample-harness' }, metrics: [
      metric('test.run.count', '1', one(1)),
      metric('test.run.tests.passed', '1', one(passed)),
      metric('test.run.tests.failed', '1', one(failed)),
      metric('test.run.tests.skipped', '1', one(0)),
      metric('test.run.duration', 'ms', one(totalMs)),
      metric('test.file.duration', 'ms', pts.file),
      metric('test.case.duration', 'ms', pts.slow),
    ] }] } };
}

console.log(`agent ${triplet}  service.name=${service}  endpoint=${endpoint}  runs=${RUNS}  interval=${INTERVAL_MS / 1000}s${dry ? '  (dry run)' : ''}`);
const expected = { passed: 0, failed: 0, ms: 0 };
let bad = 0;
for (let r = 0; r < RUNS; r++) {
  const { totals, body } = buildRun(r);
  expected.passed += totals.passed; expected.failed += totals.failed; expected.ms += totals.totalMs;
  const line = `run ${r + 1}/${RUNS}: ${FILES.length} files, ${totals.passed} passed, ${totals.failed} failed, ${(totals.totalMs / 1000).toFixed(1)} s${totals.failing ? ', failing file: ' + totals.failing.split('/').pop() : ''}`;
  if (dry) { console.log('  ' + line); continue; }
  const res = await fetch(endpoint + '/v1/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ resourceMetrics: [body] }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ status: 'fetch failed: ' + e.message, text: async () => '' }));
  console.log(`  ${line}  -> HTTP ${res.status} ${(await res.text()).slice(0, 60)}`);
  if (res.status !== 200) bad++;
  if (r < RUNS - 1) await new Promise((ok) => setTimeout(ok, INTERVAL_MS));
}
console.log(`totals sent: ${RUNS} runs, ${expected.passed} passed, ${expected.failed} failed, ${(expected.ms / 1000).toFixed(1)} s total (what the tiles should show)`);
process.exit(bad ? 1 : 0);
