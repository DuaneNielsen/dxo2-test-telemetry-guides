# Part 2: A test-time dashboard in DX O2, built from JSON with curl

Companion to `otel-test-harness-guide.md` (the harness and collector side).
This part defines **what the harness must send** so DX O2 can chart it, and
shows how to **create the "Test Time" dashboard** from JSON with plain `curl`.

Nothing here depends on other documentation or tooling. Every API call and query
below was **run against a live DX O2 tenant** unless it is marked **(not tested)**.
Anything **inferred** is marked **(inferred)**.

## 0. What you will build

The **Test Time** dashboard answers four questions about your test suite:

| Question | Panel |
|---|---|
| How many runs, passes and failures, and how long did testing take? | Five tiles: **Test runs**, **Tests failed**, **Tests passed**, **Total test time**, **Files failed** |
| Which test files failed in their latest run? | A **status map**: one square per file, red = failed |
| Which individual tests are slowest? | A table: **Slowest individual tests** |
| Where does the time go? | A table: **Top 15 test files by total time** |

The dashboard charts **metrics**. A span becomes a dashboard number only after
DX O2 has turned it into a metric, so this guide defines a small set of
**test metrics** (section 1) that the harness sends next to its spans.

## 1. The metric contract: what the harness sends

### 1.1 The metrics

All are **delta sums** (each data point is the amount for one run, not a running
total) because the dashboard adds the data points up over a time window.

| Metric | Unit | One data point per | Attributes (data-point) | Used by |
|---|---|---|---|---|
| `test.run.count` | count | test run | none | Test runs |
| `test.run.tests.passed` | count | test run | none | Tests passed |
| `test.run.tests.failed` | count | test run | none | Tests failed |
| `test.run.tests.skipped` | count | test run | none | (optional tile) |
| `test.run.duration` | ms | test run | none | Total test time |
| `test.file.duration` | ms | test file, per run | `test.suite.name` (the file path), `test.suite.run.status` (`success` or `failure`) | Status map, Files failed, Top files |
| `test.case.duration` | ms | test case | `test.case.name`, `test.suite.name`, `test.case.result.status` (for example `pass`), optional project name | Slowest tests |

Notes:

- **Only `pass` was observed** as a `test.case.result.status` value. Use whatever
  your runner reports, and filter or colour on it as you wish.
- `test.case.duration` is the high-volume one. Following the strategy of Part 1,
  **send it only for tests above a time threshold** (for example 1 s). The
  "Slowest tests" panel shows the top 25, so it does not need the fast ones.
- Keep the attribute **names** stable. The dashboard queries them by name.

### 1.1a The most important rule: one point per series per minute

DX O2 keeps **one value per series per minute**. If several points for the same
series arrive in the same minute, it does **not** add them up. It stores
**`number of points x the last value`**. Verified against a live tenant:

| What was sent (same series, same minute) | What DX O2 stored |
|---|---|
| three separate requests, values 10, 20, 30 | **90** (3 x 30) |
| one request, three points, values 100, 200, 300 | **900** (3 x 300) |
| one request, two points with the same timestamp, 5 and 9 | **18** (2 x 9) |
| six test runs sent back to back (passed counts 129, 129, 127, 129, 129, 127) | **762** (6 x 127) instead of 770 |

Recent payload timestamps did not help: points stamped a few minutes in the past
still landed in the **minute they arrived**. A single point stamped three hours
in the past was stored at its own time, so old history can be back-filled, but
recent points cannot be spread over several minutes.

What this means for a harness:

- Send **one point per series per minute**, in real time.
- If two runs can finish within the same minute, **add their values yourself**
  before sending (one data point per series, carrying the sum).
- A harness that reports each run when it ends is fine, as long as runs of the
  same suite are more than a minute apart. Parallel runs need a shared
  aggregation step (or a collector that sums per minute).
- Series that differ in an attribute value are different series. Two *different*
  test files in the same minute do not collide; two runs of the *same* file do.
- Symptom of a collision: a tile shows `N x (last value)`. A tile that is
  exactly a multiple of your last run's value is the giveaway.
- **Points can take minutes to appear, and the stored minute is not always the
  stamped minute.** A run-level point stamped 14:35 (its interval was 219 s long)
  became visible about five minutes later, stored in the 14:40 minute. Other
  points were visible within a minute. The cause was not established; if a
  tile looks stale, wait a few minutes before assuming the send failed. Keep
  each point's start-to-end interval short (a minute or less) to be safe.
- **Not tested:** cumulative (non-delta) counters, and whether a collector's
  aggregation processors remove the problem.

### 1.2 Attributes are queryable, and that has a cost

NASSQL reads data-point attributes as columns named `metric.attr.<attribute
name>`, and can group, filter and sort on them. The Test Time dashboard relies
on this (for example, grouping `test.file.duration` by
`metric.attr.test.suite.name`). It was **tested** (section 4).

Every distinct combination of attribute values is its own series. A file path
and a status are bounded by the size of your suite, which is fine. Do **not**
put unbounded values (timestamps, run IDs, random IDs) in attributes.

### 1.3 Identity: which agent do these metrics belong to?

DX O2 files incoming OpenTelemetry data under an **agent**, with the name
`SuperDomain|<host>|<process>|<agent>`. The dashboard needs to know which
agent carries your `test.*` metrics (section 3).

| Resource attribute | Need | Notes |
|---|---|---|
| `service.name` | mandatory | Also becomes a branch of the span-derived metrics. Use a small fixed set. |
| `host.name` (or `k8s.pod.name`) | mandatory per DX O2's ingestion notes | |
| `broadcomAgentTriplet` | optional | `host\|process\|agent`; sets the agent name explicitly. **Make it constant, never per run.** Whether it replaces `host.name` is **unverified**. |

The `resource` processor that sets these must run in **every** collector pipeline
that exports to DX O2 (traces **and metrics**), or the data is not attributed to
an agent.

### 1.4 Spans become metrics too

Independently of the contract above, DX O2 turns **spans** into metrics under
`<agent>|Services|<service.name>|<span name>`, with `Average Response Time (ms)`,
`Errors Per Interval` and `Responses Per Interval` (observed). Consequences:

- **The span name is a branch of the tree.** Use stable names (`test run`,
  `tool <name>`), and put anything variable in an attribute. In a live tenant,
  every distinct test title used as a span name became its own metric path.
- A span with status `ERROR` drives `Errors Per Interval`.
- Because the harness emits tool spans only when slow, large or failed, these
  derived metrics describe those calls only.

### 1.5 How to produce the test metrics

**Option A: the harness sends them directly (recommended).** Request **delta**
temporality from the SDK (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`)
and record each value as a counter. A **tested, runnable version** is
`examples/run-tests-with-otel.mjs`: it runs `node:test` files, measures every
file and test, and sends exactly the metrics in 1.1. (`examples/send-sample-test-metrics.mjs`
sends made-up data, for filling a dashboard before a real harness exists.)
The Python below shows the same idea with the OpenTelemetry SDK; it was
**not run**:

```python
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.resources import Resource

reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint="http://127.0.0.1:4318/v1/metrics", timeout=2),
    export_interval_millis=60_000)
provider = MeterProvider(resource=Resource.create({
    "service.name": "myapp-tests", "host.name": HOSTNAME}), metric_readers=[reader])
meter = provider.get_meter("test-harness")

run_count  = meter.create_counter("test.run.count")
run_ms     = meter.create_counter("test.run.duration", unit="ms")
n_passed   = meter.create_counter("test.run.tests.passed")
n_failed   = meter.create_counter("test.run.tests.failed")
file_ms    = meter.create_counter("test.file.duration", unit="ms")
case_ms    = meter.create_counter("test.case.duration", unit="ms")

# at the end of a run:
run_count.add(1); run_ms.add(total_ms); n_passed.add(passed); n_failed.add(failed)
for f in files:                       # one data point per test file
    file_ms.add(f.ms, {"test.suite.name": f.path,
                       "test.suite.run.status": "failure" if f.failed else "success"})
for t in slow_tests:                  # only tests above the threshold
    case_ms.add(t.ms, {"test.case.name": t.name, "test.suite.name": t.file,
                       "test.case.result.status": t.status})
provider.force_flush(timeout_millis=3000); provider.shutdown()
```

**Option B: the collector derives them from spans.** The reference deployment
for this dashboard sends spans and builds `test.run.*` and `test.file.duration`
with the collector's span-to-metrics connector (`signaltometrics`), keyed on
span attributes. That works, but it is more configuration and is **not
reproduced here**.

Either way, the collector needs a **metrics pipeline** next to the traces one
(Part 1, section 7), with the same `resource` processor:

```yaml
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource/test, batch]
      exporters: [otlphttp/backend]
```

## 2. Calling the DX O2 API with curl

### 2.1 Base URL and credentials

| Value | Where it comes from |
|---|---|
| Gateway host | Ends with `/`. For the `dxi-na1` region: `https://apmgw.dxi-na1.saas.broadcom.com/`. |
| Cohort ID | Settings > Connector Parameters. In the URL it is **lower-case with the dashes removed**. |
| **User token** | Settings > Manage Tokens > New Token > **User**. Sent as a Bearer token. |

The dashboard and query APIs take a **user** token. The **agent** token used to
*send* telemetry is a different credential.

```bash
GW="https://apmgw.dxi-na1.saas.broadcom.com/"                       # must end with /
COHORT="$(printf '%s' "$DXO2_COHORT_ID" | tr -d '-' | tr 'A-Z' 'a-z')"
BASE="${GW}${COHORT}"
H="Authorization: Bearer $DXO2_USER_TOKEN"                         # keep the token in the environment
export GW COHORT BASE H                                            # so scripts and child processes see them too
```

`DXO2_COHORT_ID` and `DXO2_USER_TOKEN` are names used in this guide. Use
whatever environment variables hold those two values in your setup; only the
variable names change.

Never paste the token into a script, a chat or a repository. The same goes for
**raw API responses**: the dashboard `url` in a create or search response
contains your (lower-case) cohort ID, so redact it before you share output.

### 2.2 The calls

| Operation | Request | Tested result |
|---|---|---|
| Run a NASSQL query | `POST $BASE/metrics/nassQuery` with `{"query":[...],"limit":N}` | HTTP 200, a JSON array whose first row is the column names. |
| Search dashboards by title | `GET $BASE/dxd/api/search?type=dash-db&query=<title>` | HTTP 200, `[]` when nothing matches. |
| **Create** a dashboard | `POST $BASE/dxd/api/dashboards/db` with the body in 5.1 | HTTP 200 `{"id":..,"slug":..,"status":"success","uid":..,"url":..,"version":1}`. |
| **Overwrite** it | the same request with `"overwrite": true` | HTTP 200, `version` goes up each time. |
| **Delete** it | `DELETE $BASE/dxd/api/dashboards/uid/<uid>` | HTTP 200 `{"message":"Dashboard ... deleted"}`; a later `GET .../dashboards/uid/<uid>` returns 404. |
| Export one | `GET $BASE/dxd/api/dashboards/uid/<uid>` | Returns `{"meta":{..},"dashboard":{..}}` (tested through a client that calls this endpoint). |
| Create with an existing uid and `overwrite:false` | | **(not tested)** One client's source indicates HTTP 412. |

```bash
curl -sS -X POST -H "$H" -H 'Content-Type: application/json' \
     --data @dashboard.body.json "$BASE/dxd/api/dashboards/db" -w '\nHTTP %{http_code}\n'
```

### 2.3 Looking at the result

Rendering a dashboard to an image needs a browser-style login (tenant slug and
account password, which returns session cookies), so it is not a one-line
`curl`. The simplest check is to open the dashboard in the DX O2 UI. A render
tool sometimes stalls and works on retry; allow up to three attempts.

## 3. NASSQL: the queries behind the dashboard

A NASSQL query is a **JSON pipeline**: the first step reads data, later steps
transform it, and the last is `KEEP`.

```json
{ "query": [ <step>, <step>, ... ], "limit": 100 }
```

### 3.1 The steps used

| Step | Meaning |
|---|---|
| `FROM` | Read data points. Columns: `data.time`, `data.value`, `metric.source`, `metric.path`, `metric.id`, and every attribute as `metric.attr.<name>`. |
| `FILTER` | Keep rows that match, for example `{"op":"FILTER","spec":{"op":"REGEX","column":"metric.attr.test.suite.run.status","pattern":"^failure$","ignoreCase":false}}`. |
| `GROUP` | Group by `columns`. Takes effect at the next aggregator. |
| `SUM`, `MAX`, `MIN`, `MEAN`, `COUNT` | Aggregate: `{"op":"SUM","column":"data.value","as":"total_ms"}`. |
| `ORDER` | `{"columns":[{"column":"total_ms","sortDescending":true}],"topN":15}` |
| `SCRIPT` | Compute a new column with a small JavaScript function (used for the status map). |
| `KEEP` | Choose the output columns. Must be **last**. |

### 3.2 Choosing the metrics: the `FROM` step

```json
{ "op": "FROM",
  "querySpecifier": { "op": "SPEC",
    "sourceNameSpecifier":    { "op": "REGEX", "pattern": ".*\\|MyTests\\|my-test-agent" },
    "attributeNameSpecifier": { "op": "REGEX", "pattern": ".*test\\.file\\.duration$" },
    "clampSize": 0 },
  "queryRange": { "endTime": 0, "rangeSize": 86400000, "frequency": 60000 } }
```

- **Source** = the agent path `SuperDomain|<host>|<process>|<agent>`. Match it with
  a leading `.*\|` and the last two parts.
- **Attribute** = the metric name. A regex must match the **whole** string, so
  use `.*` explicitly.
- `|` is a regex operator, so write `\|` in the regex and **`\\|` in JSON**.
- `queryRange` is in **milliseconds**: `rangeSize` 86400000 = 24 hours,
  `frequency` 60000 = 1 minute. **`endTime: 0` means "now"** (tested: it returns
  the same data as passing the current time in ms).
- With a fixed `queryRange`, the panel ignores the dashboard's time picker. The
  Test Time dashboard does this on purpose, and says so in its header.

### 3.3 The panel queries

Each pipeline starts with a `FROM` like the one in 3.2; only the metric name and
the window change.

| Panel | Pipeline |
|---|---|
| Test runs, Tests passed, Tests failed, Total test time | `FROM(<metric>, 24 h)` then `SUM data.value as v` then `KEEP [v]`. Metrics: `test.run.count`, `test.run.tests.passed`, `test.run.tests.failed`, `test.run.duration`. |
| Files failed | `FROM(test.file.duration, 24 h)` then `FILTER status = ^failure$` then `GROUP [metric.attr.test.suite.name]` then `SUM as ms` then `KEEP [suite, ms]`. The tile **counts the rows**. |
| Status map | `FROM(test.file.duration, 30 days)` then **`ORDER data.time ascending`** then `SCRIPT` (below) then `KEEP [data.time, metric.attr.test.suite.name, flag]`. The sort is essential, see 3.5 item 5. |
| Slowest tests | `FROM(test.case.duration, 24 h)` then `GROUP [project?, suite, case, status]` then `SUM as ms` then `ORDER ms desc, topN 25` then `KEEP`. |
| Top files | `FROM(test.file.duration, 24 h)` then `GROUP [suite, status]` then `SUM as total_ms` then `ORDER desc, topN 15` then `KEEP`. |

The status-map script turns the status into a number (1 = failed):

```json
{ "op": "SCRIPT", "inputColumns": ["metric.attr.test.suite.run.status"], "outputColumns": ["flag"],
  "script": "(function nassqlfn(rows){return rows.map(function(r){return r==='failure'?1:0;});})" }
```

### 3.4 Try a query by itself first

Test every query with `curl` before you put it in a panel. This is one of the
panel queries, run directly (**tested**; it returned the top files by total
time with their status):

```bash
curl -sS -X POST -H "$H" -H 'Content-Type: application/json' \
     --data @top-files.json "$BASE/metrics/nassQuery"
```

```json
{"query":[
 {"op":"FROM","querySpecifier":{"op":"SPEC",
   "sourceNameSpecifier":{"op":"REGEX","pattern":".*\\|MyTests\\|my-test-agent"},
   "attributeNameSpecifier":{"op":"REGEX","pattern":".*test\\.file\\.duration$"},"clampSize":0},
  "queryRange":{"endTime":0,"rangeSize":86400000,"frequency":60000}},
 {"op":"GROUP","columns":["metric.attr.test.suite.name","metric.attr.test.suite.run.status"]},
 {"op":"SUM","column":"data.value","as":"total_ms"},
 {"op":"ORDER","columns":[{"column":"total_ms","sortDescending":true}],"topN":5},
 {"op":"KEEP","columns":["metric.attr.test.suite.name","metric.attr.test.suite.run.status","total_ms"]}],
 "limit":10}
```

The response is an array. The first row is the column names:

```json
[["metric.attr.test.suite.name","metric.attr.test.suite.run.status","total_ms"],
 ["tests/a.test.js","success",39636],
 ["tests/b.test.js","failure",22247]]
```

If you do not know your agent path or metric names, discover them: use the
`FROM_METADATA` step, which lists metrics instead of data points, with a broad
`attributeNameSpecifier` and a small `limit` **(not tested)**.

### 3.5 Pitfalls found while testing

1. **`Unrecognized character escape '|'` (HTTP 400).** The JSON contained `\|`
   instead of `\\|`. Shells and some tools remove one level of backslashes, so
   an inline string or a heredoc can quietly change your pattern. **Write JSON
   with a file-writing tool or generate it with a script (`JSON.stringify`
   does the escaping), and check the bytes.**
2. **No error, no rows.** A wrong regex, a wrong agent path, or a window with
   no data returns an empty result with HTTP 200. Run the simplest query first,
   then add steps.
3. **Units.** In a NASSQL `queryRange` every number is milliseconds.
4. **Delta, not cumulative.** If the tiles grow without bound or double count,
   the metrics were sent as cumulative totals; send delta (section 1.5).
5. **Rows come back grouped by series, not by time.** A file that failed once and
   then passed has **two** series (status `success` and status `failure`), and
   the `failure` series is returned *after* the `success` one, so its old point
   looks like the file's latest value. A panel that shows each item's "last"
   value (the status map) then shows a file red even though its latest run
   passed. **Add `ORDER data.time ascending` before such a panel's `KEEP`.**
   Verified: without the sort, two files showed red (one wrongly); with it, only
   the file whose latest run failed was red. A dashboard that was built without
   this step can have the same flaw.
6. **One point per series per minute** (section 1.1a). Tiles that are a multiple
   of your last run's value mean several points landed in the same minute.

## 4. Building the dashboard from JSON

### 4.1 The create / overwrite request

```json
{ "dashboard": { "id": null, "uid": "test-time", "title": "Test Time",
                 "schemaVersion": 27, "panels": [ ... ] },
  "overwrite": false,
  "folderId": 0,
  "message": "created by script" }
```

- `uid`: at most 40 characters; use it to overwrite and delete. **For a trial,
  pick a distinctive uid and title** (for example `test-time-trial`): a title
  search also returns other people's dashboards, and a clash with an existing
  uid replaces or rejects yours.
- `id`: `null`. `folderId`: the folder's **numeric** id, not its name or uid; `0`
  is the General folder. The folder is not part of the dashboard JSON.
- `overwrite: true` replaces the dashboard with the same `uid`.
- The title must not equal the name of the folder it goes in.
- Panel `id`s must be unique within the dashboard; a duplicate silently loses a panel.
- The grid is **24 columns**: every panel has `gridPos {x, y, w, h}` with `x + w <= 24`.
- Use `schemaVersion: 27` with `stat`, `table` and `text` panels. The status map
  uses the **polystat** panel plugin (`grafana-polystat-panel`), which must be
  installed on the tenant.

### 4.2 The wrapper around every query (the "target")

Every panel here has one `target`. Its shape is fixed, and the plugin fails if
fields are missing. Two spellings are intentional and must be kept
(`aggregationCatergory`). Only the **pipeline string** changes between panels.

```json
{
  "additionalParams": { "alias": "", "clampSize": 100, "frequency": "auto",
                        "legendMetricCustomValues": [""], "legendMetricField": "Metric", "plotCategories": ["value"] },
  "advanceQuery": false,
  "aggregations": { "aggregateBy": "", "aggregationCatergory": "None", "displayTimeSeries": false,
                    "enableAggregation": false, "limit": "", "order": "TOP", "resultFormat": "Time Series" },
  "basicFilters": [{ "attributeNameSpecifier": [{ "ignoreCase": false, "isNot": false, "logicalOperator": "AND", "op": "REGEX", "pattern": "" }],
                     "isNot": false, "logicalOperator": "AND", "op": "SPEC",
                     "sourceNameSpecifier": [{ "isNot": false, "logicalOperator": "AND", "op": "ALL" }] }],
  "datasource": "AIOps_Metrics",
  "datasourceType": "AIops_NASS",
  "isRawQuery": false,
  "nassAggregations": {
    "aggregationsRawQuery": "<the pipeline, as a JSON STRING>",
    "nassAggModeValues": { "seriesName": [""], "xaxis": "", "yaxis": [""] },
    "nassAggregationMode": "Table",
    "nassAggregationsEnabled": true },
  "rawQuery": "", "refId": "A", "tenantId": ""
}
```

`aggregationsRawQuery` is the whole `{"query":[...]}` pipeline **encoded as a
string**, so its quotes and backslashes are escaped. **Do not write that by
hand**: build the pipeline as an object in code and call `JSON.stringify`.

For the status map only, the mode and fields differ:
`nassAggregationMode: "Time Series"`, `seriesName: ["metric.attr.test.suite.name"]`,
`xaxis: "data.time"`, `yaxis: ["flag"]`.

### 4.3 Panel settings

**Tile (stat).** A single number. The settings used:

```json
{ "type": "stat", "id": 2, "title": "Test runs", "datasource": "AIOps_Metrics",
  "gridPos": { "h": 4, "w": 5, "x": 0, "y": 3 },
  "fieldConfig": { "defaults": { "mappings": [], "unit": "short",
      "thresholds": { "mode": "absolute", "steps": [ {"color":"green","value":null} ] } }, "overrides": [] },
  "options": { "colorMode": "value", "graphMode": "none", "justifyMode": "auto", "orientation": "auto",
               "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" } }
```

Use unit `ms` for Total test time. Colour **Tests failed** green at 0 and red
from 1 (`steps: [{green, null}, {red, 1}]`). **Files failed** counts rows:
`reduceOptions: {"calcs":["count"],"fields":"/^ms$/"}`, `noValue: "0"`, red from 1.

**Table.** `type: "table"`, `options: {"showHeader": true}`, and a rename of the
`metric.attr.*` columns to readable headings:

```json
"transformations": [ { "id": "organize", "options": { "renameByName": {
    "metric.attr.test.suite.name": "Test file",
    "metric.attr.test.suite.run.status": "Status",
    "total_ms": "Total ms" } } } ]
```

In "Slowest tests", the `ms` column is shown as a gradient bar with orange from
3000 and red from 10000 ms (a column override: `custom.displayMode` =
`gradient-gauge`, `unit` = `ms`).

**Status map.** `type: "grafana-polystat-panel"`; one square per series, red when
the value is 1 (`globalThresholds` 0 = green, 1 = red; `shape: "square"`).
The complete settings are in the generator script.

### 4.4 Generate the JSON with the script

The wrapper and the escaped pipelines are the error-prone parts, so generate
them. The script `examples/make-test-time-dashboard.js` (no dependencies,
Node 18 or newer) builds the whole request body:

```bash
node examples/make-test-time-dashboard.js \
     --agent "MyTests|my-test-agent" \
     --uid test-time --title "Test Time" --folder-id 0 \
     --out dashboard.body.json
```

Options: `--project-attr <name>` adds a project column to the slowest-tests table;
`--overwrite` replaces an existing dashboard with the same uid;
`--run-window-ms` and `--status-window-ms` change the windows.

**Verification of the script:** its output was compared with the JSON of a
working Test Time dashboard (the reference deployment). The queries and wrappers
of the data panels are identical, and the panel settings are identical, except
for three deliberate differences: "Tests failed" is green at zero; the
top-files table omits the reference project's per-file descriptions; and the
status map has **one extra step, a sort by time** (see 3.5 item 5), which fixes
a case where the reference version shows a file red although its latest run passed.
**Independent test:** a fresh, headless Claude session was given only these
documents and the generator, and asked to build the dashboard. It imported the
generated body (HTTP 200, 9 panels), re-ran all eight stored panel queries
(each returned HTTP 200) and the dashboard it created was **identical, panel
by panel, to the generator's output** and rendered with live data.

### 4.5 The whole loop

```bash
node examples/make-test-time-dashboard.js --agent "MyTests|my-test-agent" --out dashboard.body.json
curl -sS -X POST -H "$H" -H 'Content-Type: application/json' \
     --data @dashboard.body.json "$BASE/dxd/api/dashboards/db"
# verify it exists and has the expected number of panels (9 for this generator):
curl -sS -H "$H" "$BASE/dxd/api/dashboards/uid/test-time" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).dashboard;console.log(d.title,d.panels.length+' panels')})"
# then open the dashboard in DX O2 and check every panel shows data
# to change it: re-run with --overwrite and POST again
# to remove it:
curl -sS -X DELETE -H "$H" "$BASE/dxd/api/dashboards/uid/test-time"
```

## 5. If a panel shows "No data"

Check in this order:

1. **Run the panel's query by itself** with `curl` (section 3.4). If it returns
   only the header row, the data is not there under that name. To tell **"no
   failures"** from **"no data"** for a filtered panel such as *Files failed*,
   run the same query **without the `FILTER` step**: rows there mean the data
   exists and nothing matched the filter. You can also re-run every stored query:
   fetch the dashboard (`GET .../dashboards/uid/<uid>`), take each panel's
   `targets[0].nassAggregations.aggregationsRawQuery`, and POST it to `/metrics/nassQuery`.
2. **Is the agent path right?** Look at the `--agent` value against the real agent
   name in DX O2; the regex must match `SuperDomain|<host>|<process>|<agent>`.
3. **Are the metrics arriving?** Query a single metric, over a wide window,
   with `KEEP` on `metric.source` and `metric.path`.
4. **Is the window right?** The panels use fixed windows (24 h, 30 days).
5. **Delta vs cumulative** (section 3.5).
6. **Attribute names.** They are case-exact: `test.suite.name`, `test.suite.run.status`.

## Appendix: panels written in the form style (tested)

The reference dashboard writes its queries as raw NASSQL (section 4.2). The
product also has a form-style target (a "basic filter" with regexes instead of
a pipeline). Findings from testing form-style `stat`, `graph` and `table` panels,
in case you use them:

| Symptom | Cause | Fix |
|---|---|---|
| Graph with a saw-tooth to zero; stat showing `0 B` | Data reported every 30 s, but `additionalParams.frequency` was `"auto"`, so alternate buckets were empty. | Set `frequency` to `"60"` (**seconds**). `"60000"` was read as seconds and gave a near-empty graph. |
| Table: columns but "No data to show" | The regexes were in `basicFilters`. | For table mode, put them in `querytFilters` and leave `basicFilters` blank. |
| Stat shows 0 | `lastNotNull` picked an empty bucket. | `calcs: ["max"]`, or a larger `frequency`. |
| A raw-NASSQL panel with no `queryRange` | | It uses the **dashboard's time range** instead. |

## 6. What was and was not tested

**Tested against a live tenant:** NASSQL over HTTP (including grouping and
filtering on `metric.attr.*`, and `endTime: 0`); dashboard create, overwrite
(three times) and delete over HTTP; title search; a 404 after delete; `stat`,
`graph` and `table` panels with real data (form style); a raw-NASSQL table
panel; the full Test Time dashboard (rendered with real data, in the reference
deployment); local comparison of the generator output with that dashboard.

**Also tested:** importing the generated Test Time body into a tenant (by an
independent headless session, from these documents alone); sending the `test.*`
metrics to the OTLP gateway with an agent token (HTTP 200, and the values were
queryable straight away); the "one point per series per minute" behaviour (section 1.1a).

**Not tested:** the Python metric emitter in 1.5 (the JavaScript sender in
`examples/` is what was run); option B (collector-derived metrics);
duplicate-uid behaviour; folder creation and other folder IDs; template
variables; the modern `timeseries` panel type; data links; whether an **agent**
token can call these APIs (the examples use a **user** token); which span kind
or attribute decides Frontends versus Services; limits (size, rate, retry).

**Files** (`docs/examples/`):

- `make-test-time-dashboard.js`: builds the dashboard request body (section 4.4).
- `run-tests-with-otel.mjs`: a small **reference harness**. It runs `node:test` files (several at a time), measures every file and test, prints a summary, and sends the `test.*` metrics in one request. Use `--dry-run` first to read the summary before anything is sent. The test processes get a throw-away home directory and a copy of the environment with every token and password variable removed. It was run against a real test suite (72 files) and the results appeared on the dashboard. Note that a test file that hangs is killed after 180 s and reported as a failed file with a duration of about 180 s; the harness cannot tell a hang from a failure.
- `send-sample-test-metrics.mjs`: sends sample test runs in the metric contract's format, one run per minute (section 1.1a explains why). Use it to fill the dashboard with data before your real harness is wired up. Needs an **agent** token in an environment variable. Run `--dry-run` first.
