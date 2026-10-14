#!/usr/bin/env node
// Builds the import request body for a "Test Time" dashboard in DX O2.
//
//   node make-test-time-dashboard.js --agent "Process|agent-name" --out dashboard.body.json
//
// Required
//   --agent  "<process>|<agent>"   the last two parts of the agent path that carries your test.* metrics
//                                   (agent path = SuperDomain|<host>|<process>|<agent>; the host part is matched with .*)
// Optional
//   --out <file>            default dashboard.body.json
//   --uid <uid>             default test-time          (max 40 characters)
//   --title <title>         default "Test Time"
//   --folder-id <n>         default 0 (the General folder); must be the folder's numeric id
//   --overwrite             replace a dashboard that already has this uid
//   --project-attr <name>   attribute holding the project name on test.case.duration, or "none" (default "none")
//   --run-window-ms <n>     window for the tiles and tables, default 86400000 (24 h)
//   --status-window-ms <n>  window for the file status map, default 2592000000 (30 days)
//
// Metric names and attribute names below are the "contract" the harness must send (see the guide).
const fs = require('fs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt; };
const has = (name) => process.argv.includes('--' + name);

const agent = arg('agent');
if (!agent || !agent.includes('|')) { console.error('--agent "<process>|<agent>" is required, for example --agent "MyTests|my-test-agent"'); process.exit(2); }
const OUT = arg('out', 'dashboard.body.json');
const UID = arg('uid', 'test-time');
const TITLE = arg('title', 'Test Time');
const FOLDER_ID = Number(arg('folder-id', '0'));
const PROJECT = arg('project-attr', 'none');
const RUN_WINDOW = Number(arg('run-window-ms', '86400000'));
const STATUS_WINDOW = Number(arg('status-window-ms', '2592000000'));
if (UID.length > 40) { console.error('uid must be at most 40 characters'); process.exit(2); }

// ---- names the harness must send --------------------------------------------------------------
const M = { runs: 'test.run.count', failed: 'test.run.tests.failed', passed: 'test.run.tests.passed',
            runMs: 'test.run.duration', fileMs: 'test.file.duration', caseMs: 'test.case.duration' };
const A = { suite: 'metric.attr.test.suite.name', fileStatus: 'metric.attr.test.suite.run.status',
            test: 'metric.attr.test.case.name', caseStatus: 'metric.attr.test.case.result.status',
            project: PROJECT === 'none' ? null : 'metric.attr.' + PROJECT };

// ---- helpers ----------------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');                  // regex-escape one literal
const SOURCE = '.*\\|' + agent.split('|').map(esc).join('\\|');               // e.g. .*\|Process\|agent-name
const metricRe = (name) => '.*' + esc(name) + '$';                            // e.g. .*test\.file\.duration$

const from = (metric, windowMs) => ({
  op: 'FROM',
  querySpecifier: { op: 'SPEC',
    sourceNameSpecifier: { op: 'REGEX', pattern: SOURCE },
    attributeNameSpecifier: { op: 'REGEX', pattern: metricRe(metric) },
    clampSize: 0 },
  queryRange: { endTime: 0, rangeSize: windowMs, frequency: 60000 },          // endTime 0 = now; all values in ms
});
const keep = (cols) => ({ op: 'KEEP', columns: cols });
const sum = (as) => ({ op: 'SUM', column: 'data.value', as });
const top = (col, n) => ({ op: 'ORDER', columns: [{ column: col, sortDescending: true }], topN: n });

// the wrapper every panel's query sits in (copied from a working dashboard; do not drop fields)
function target(pipeline, { mode = 'Table', seriesName = [''], xaxis = '', yaxis = [''] } = {}) {
  return {
    additionalParams: { alias: '', clampSize: 100, frequency: 'auto', legendMetricCustomValues: [''], legendMetricField: 'Metric', plotCategories: ['value'] },
    advanceQuery: false,
    aggregations: { aggregateBy: '', aggregationCatergory: 'None', displayTimeSeries: false, enableAggregation: false, limit: '', order: 'TOP', resultFormat: 'Time Series' },
    basicFilters: [{ attributeNameSpecifier: [{ ignoreCase: false, isNot: false, logicalOperator: 'AND', op: 'REGEX', pattern: '' }],
                     isNot: false, logicalOperator: 'AND', op: 'SPEC',
                     sourceNameSpecifier: [{ isNot: false, logicalOperator: 'AND', op: 'ALL' }] }],
    datasource: 'AIOps_Metrics', datasourceType: 'AIops_NASS', isRawQuery: false,
    nassAggregations: { aggregationsRawQuery: JSON.stringify({ query: pipeline }),   // the pipeline travels as a JSON string
                        nassAggModeValues: { seriesName, xaxis, yaxis },
                        nassAggregationMode: mode, nassAggregationsEnabled: true },
    rawQuery: '', refId: 'A', tenantId: '',
  };
}

const statPanel = ({ id, title, x, w, metric, unit, color = 'green', redAt }) => ({
  type: 'stat', id, title, datasource: 'AIOps_Metrics', gridPos: { h: 4, w, x, y: 3 },
  targets: [target([from(metric, RUN_WINDOW), sum('v'), keep(['v'])])],
  fieldConfig: { defaults: { mappings: [], unit,
    thresholds: { mode: 'absolute', steps: redAt === undefined ? [{ color, value: null }] : [{ color: 'green', value: null }, { color: 'red', value: redAt }] } }, overrides: [] },
  options: { colorMode: 'value', graphMode: 'none', justifyMode: 'auto', orientation: 'auto',
             reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, textMode: 'auto' },
});

const tableBase = { fieldConfig: null, options: { showHeader: true } };

const panels = [
  { type: 'text', id: 1, title: '', gridPos: { h: 3, w: 24, x: 0, y: 0 }, transparent: true,
    options: { mode: 'markdown', content: '**Test time** (agent `' + agent + '`). Tiles and tables cover the last ' + Math.round(RUN_WINDOW / 3600000) +
      ' hours; the time picker does not change them. Source: test.* metrics sent by the test harness.' } },

  statPanel({ id: 2, title: 'Test runs', x: 0, w: 5, metric: M.runs, unit: 'short' }),
  statPanel({ id: 3, title: 'Tests failed', x: 5, w: 5, metric: M.failed, unit: 'short', redAt: 1 }),
  statPanel({ id: 4, title: 'Tests passed', x: 10, w: 5, metric: M.passed, unit: 'short' }),
  statPanel({ id: 7, title: 'Total test time', x: 15, w: 5, metric: M.runMs, unit: 'ms' }),

  // Files failed: one row per failing file; the stat counts the rows.
  { type: 'stat', id: 8, title: 'Files failed', datasource: 'AIOps_Metrics', gridPos: { h: 4, w: 4, x: 20, y: 3 },
    targets: [target([from(M.fileMs, RUN_WINDOW),
      { op: 'FILTER', spec: { op: 'REGEX', column: A.fileStatus, pattern: '^failure$', ignoreCase: false } },
      { op: 'GROUP', columns: [A.suite] }, sum('ms'), keep([A.suite, 'ms'])])],
    fieldConfig: { defaults: { mappings: [], noValue: '0', unit: 'short',
      thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] } }, overrides: [] },
    options: { colorMode: 'value', graphMode: 'none', justifyMode: 'auto', orientation: 'auto',
               reduceOptions: { calcs: ['count'], fields: '/^ms$/', values: false }, textMode: 'auto' } },

  // Status map: one square per test file, red when its latest run failed. Needs the polystat plugin on the tenant.
  { type: 'grafana-polystat-panel', id: 10, datasource: 'AIOps_Metrics', gridPos: { h: 16, w: 24, x: 0, y: 7 },
    title: 'Test file status: result of each file\'s latest run (red = failed)',
    colors: ['#299c46', '#d44a3a'],
    targets: [target([from(M.fileMs, STATUS_WINDOW),
      // Sort by time FIRST. Rows come back grouped by series (a file's "success" series, then its "failure" series), not by
      // time, and the map shows each file's LAST row. Without this a file that failed once and then passed shows red.
      { op: 'ORDER', columns: [{ column: 'data.time', sortDescending: false }] },
      { op: 'SCRIPT', inputColumns: [A.fileStatus], outputColumns: ['flag'],
        script: '(function nassqlfn(rows){return rows.map(function(r){return r===\'failure\'?1:0;});})' },
      keep(['data.time', A.suite, 'flag'])],
      { mode: 'Time Series', seriesName: [A.suite], xaxis: 'data.time', yaxis: ['flag'] })],
    polystat: { animationSpeed: 2500, columnAutoSize: true, displayLimit: 500, fontAutoColor: true, fontAutoScale: true, globalDecimals: 0,
      globalDisplayMode: 'all', globalOperatorName: 'current',
      globalThresholds: [{ color: '#299c46', state: 0, value: 0 }, { color: '#d44a3a', state: 1, value: 1 }],
      globalUnitFormat: 'none', gradientEnabled: false, maxMetrics: 500, polygonBorderColor: '#000000', polygonBorderSize: 2,
      polygonGlobalFillColor: '#299c46', radiusAutoSize: true, rowAutoSize: true, shape: 'square', tooltipEnabled: true, valueEnabled: false },
    savedComposites: [], savedOverrides: [] },

  // Slowest individual tests (sum of their durations in the window)
  (() => {
    const group = [A.project, A.suite, A.test, A.caseStatus].filter(Boolean);
    const rename = { [A.test]: 'Test', [A.caseStatus]: 'Status', [A.suite]: 'File', ms: 'ms' };
    if (A.project) rename[A.project] = 'Project';
    return { type: 'table', id: 9, title: 'Slowest individual tests (total ms)', datasource: 'AIOps_Metrics', gridPos: { h: 12, w: 24, x: 0, y: 23 },
      targets: [target([from(M.caseMs, RUN_WINDOW), { op: 'GROUP', columns: group }, sum('ms'), top('ms', 25), keep([...group, 'ms'])])],
      fieldConfig: { defaults: { custom: { align: null, filterable: true }, mappings: [],
        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: 3000 }, { color: 'red', value: 10000 }] } },
        overrides: [{ matcher: { id: 'byName', options: 'ms' }, properties: [{ id: 'custom.displayMode', value: 'gradient-gauge' }, { id: 'unit', value: 'ms' }] }] },
      options: { showHeader: true },
      transformations: [{ id: 'organize', options: { renameByName: rename } }] };
  })(),

  // Top test files by total time
  { type: 'table', id: 6, title: 'Top 15 test files by total time', datasource: 'AIOps_Metrics', gridPos: { h: 13, w: 24, x: 0, y: 35 },
    targets: [target([from(M.fileMs, RUN_WINDOW), { op: 'GROUP', columns: [A.suite, A.fileStatus] }, sum('total_ms'),
      top('total_ms', 15), keep([A.suite, A.fileStatus, 'total_ms'])])],
    fieldConfig: { defaults: { custom: { align: null, filterable: true }, mappings: [], thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }] } }, overrides: [] },
    options: { showHeader: true },
    transformations: [{ id: 'organize', options: { renameByName: { [A.suite]: 'Test file', [A.fileStatus]: 'Status', total_ms: 'Total ms' } } }] },
];

const dashboard = {
  id: null, uid: UID, title: TITLE, tags: ['tests', 'telemetry'], schemaVersion: 27, style: 'dark', editable: true, graphTooltip: 1,
  refresh: '1m', time: { from: 'now-24h', to: 'now' }, timepicker: {}, timezone: '', templating: { list: [] }, annotations: { list: [] },
  links: [], version: 1, panels,
};

fs.writeFileSync(OUT, JSON.stringify({ dashboard, overwrite: has('overwrite'), folderId: FOLDER_ID, message: 'created by make-test-time-dashboard.js' }));
console.log('wrote ' + OUT + '  (uid ' + UID + ', ' + panels.length + ' panels, source regex ' + SOURCE + ')');
