# Tracing test runs with OpenTelemetry: a low-noise strategy

How to make a test harness emit OpenTelemetry (OTel) spans so you can see how
a test run performed and why a tool call was slow or large, **without flooding
your collector**. Generic: nothing here depends on a particular project,
runner, language or backend.

**Part 2**, `dxo2-test-dashboard-guide.md`, covers what DX O2 needs on the
data, NASSQL queries, and building a dashboard from JSON with `curl`.

> **Status of this part.** The ideas here (one summary span per run, spans only
> for slow, large or failed calls, a per-run cap, correlation through the trace
> context) were designed and reasoned through, but **the code in sections 4
> and 7 has not been run**: the Python and JavaScript helpers and the collector
> configuration are untested. Treat them as a starting point and verify them in
> your own environment (section 7.2 gives a check that needs no tests). What
> *was* run against a live DX O2 tenant, including a working test harness, is
> listed in Part 2, section 6.

## 1. The strategy in one page

| Rule | Why |
|---|---|
| **One summary span per test run** (the *run span*). It carries the overall results and performance. | You get the headline numbers from a single span, and the span count stays constant however big the suite is. |
| **Do not emit a span per test.** Roll test results up into the run span: counts, percentiles, the slowest N, and the failures. | A 5,000-test suite would otherwise emit 5,000 spans on every run. |
| **Emit a span for a tool call only when it is interesting:** slower than a time threshold, larger than a size threshold, or failed. Default 1 s and about 100 KB; tune per application. | Slow, huge and failing calls are the ones you will debug. Fast, small, successful calls are noise. |
| **Always measure every call**, whether or not a span is emitted, and roll the totals into the run span. | You keep the full picture (calls per tool, total time, total bytes) even though most spans are dropped. |
| **Every tool span is a child of the run span** (same trace ID, run span as parent) and also carries `test.run.id`. | You can always tell which run a span came from. |
| **Label test-originated spans** (`test.origin = true`, a distinct `service.name`). | Test traffic never mixes with production dashboards, and you can filter it out or isolate it with one condition. |
| **Cap spans per run** (for example 200) and count what was dropped. | A pathological run cannot flood the collector. |
| **Telemetry must never fail or slow a test.** Short export timeout, fire-and-forget, flush once at the end. | A broken collector must not break your CI. |

```
test runner ──► harness (OTel SDK) ──OTLP──► collector ──► backend(s)
   │                  │                         ▲
   │   run span ──────┤  tool spans (only if    │  receives, batches,
   │   (1 per run)    │  slow / large / failed) │  filters, exports
   └─ tool calls ─────┘
```

## 2. What goes on each span

### 2.1 The run span (one per run)

Span name: `test run`. Start it when the run starts and end it when the run
finishes. Set status `ERROR` if anything failed.

| Attribute | Example | Notes |
|---|---|---|
| `test.run.id` | `7d1c…` (UUID) | Also repeated on every child span. |
| `test.origin` | `true` | Marks the span as coming from a test run. |
| `test.suite` | `my-service` | Project or suite name. |
| `test.runner` | `pytest`, `jest` | |
| `test.total`, `test.passed`, `test.failed`, `test.skipped` | `1240`, `1236`, `3`, `1` | |
| `test.duration_ms` | `84210` | Wall time for the whole run. |
| `test.case.duration_ms.p50` / `.p95` / `.max` | `12`, `640`, `9100` | Cheap and useful; no per-test spans needed. |
| `test.slowest` | `["tests/a.py::t1=9100ms", …]` | Top 5, as a string array. |
| `test.tools.summary` | JSON string: top 10 tools by total time with `calls`, `total_ms`, `max_ms`, `total_out_bytes`, `max_out_bytes` | The roll-up of **every** call, including ones that got no span. |
| `test.tool_spans.emitted` / `.dropped` | `37`, `0` | `dropped` counts spans suppressed by the per-run cap. |
| `vcs.revision`, `vcs.branch` (or your CI's names) | | So a slow run can be tied to a commit. |

Failures go on the run span as **span events**, not as spans:
`test.failure` with `test.case.name` and a truncated message. Cap them (say
20) and set `test.failures.truncated` to the number left out.

### 2.2 Tool spans (only when interesting)

A *tool call* here means any call your tests make into the application that
you care about: an RPC, an HTTP request, a CLI invocation, an MCP tool call,
a query. Span name: `tool <tool-name>`; kind `CLIENT`.

| Attribute | Notes |
|---|---|
| `test.origin` = `true`, `test.run.id`, `tool.invoked_by` = `test` | Labels it as test-originated and ties it to the run. |
| `test.case.name` | Which test made the call. (Fine on spans. On metrics, see section 6.) |
| `tool.name` | Low-cardinality tool identifier. |
| `tool.emit_reason` | `slow`, `large`, `error`, or a combination such as `slow,large`. Tells a reader why this span exists. |
| `tool.duration_ms` | Also the span duration. |
| `tool.input.bytes`, `tool.output.bytes` | Sizes, not contents. |
| `tool.status` / error | Span status `ERROR` plus a truncated message on failure. |
| Diagnostic detail (see below) | Enough to explain *why* it was slow or large. |

**Diagnostic detail that is worth recording** (pick what applies; keep each
value short and redacted):

- argument **shape**, not values: key names, item counts, a hash of the
  arguments for de-duplication;
- queue or wait time versus execution time, if you can separate them;
- retry count, cache hit or miss, HTTP status or exit code;
- the output's **head**, truncated to about 200 characters, **on error only**;
- a few span events for phases (`connected`, `first_byte`, `parsed`).

**Never record** secrets, tokens, full request or response bodies, or
personal data. Truncate every string (2 KB is a sensible hard limit).

## 3. Why the span is created after the call

Whether a call is interesting depends on its duration, and you only know that
when it ends. So **do not start a span before the call**. Instead:

1. Record the start time and the elapsed time yourself.
2. After the call, update the run's roll-up counters (always).
3. If `duration >= SLOW_MS` **or** `output_bytes >= BIG_BYTES` **or** it
   failed, and the per-run cap is not reached, create the span now with an
   explicit `start_time` and end it with an explicit `end_time`.

Both the OTel API for Python and for JavaScript let you pass those timestamps.
This is the key trick; sampling alone cannot do it. A head sampler decides
before the call, and a collector tail sampler can only filter after every span
has already been sent (see 6).

Suggested defaults, all overridable by environment variable:

```
TEST_OTEL_SLOW_MS=1000          # tool spans at or above this duration
TEST_OTEL_BIG_BYTES=102400      # tool spans at or above this output size
TEST_OTEL_MAX_TOOL_SPANS=200    # hard cap per run
```

Choose thresholds from your own application: roughly 1 s for interactive
calls, 5 to 10 s for builds or long jobs; for bytes, a few times your normal
p99 payload. After a few runs, check what fraction of calls emits a span.
Aim for well under 5%.

## 4. Implementation

### 4.1 Setup steps (any language)

1. **Install** the OTel API, the SDK and the OTLP/HTTP exporter for your
   language.
2. **Create a `TracerProvider`** with a `Resource`:
   `service.name` = `<app>-tests` (not the app's own name),
   `deployment.environment` = `test`, `telemetry.source` = `test`.
3. **Attach a batch span processor** with an OTLP/HTTP exporter pointing at
   the collector (default `http://127.0.0.1:4318/v1/traces`) and a **short
   timeout (about 2 s)**.
4. **Start the run span** at the beginning of the run; keep its context.
5. **Collect results** in the runner's hooks (test finished, run finished).
6. **Wrap tool calls** with the helper in 4.2 or 4.3.
7. **End the run span** at the end, then **flush and shut down** the provider
   with a bounded timeout.
8. **Handle abnormal exits:** on SIGTERM or SIGINT, end the run span as an
   error (`test.killed = true`) and flush before exiting. A hard kill (SIGKILL,
   an out-of-memory kill) cannot be caught from inside the run. If that
   matters, have the launcher close the span instead.
9. **Fail open.** Wrap telemetry calls so an exception can never fail a test.

### 4.2 Python (pytest) example

`test_otel.py`:

```python
import contextlib, json, os, time, uuid
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagate import inject
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode

SLOW_MS = float(os.getenv("TEST_OTEL_SLOW_MS", "1000"))
BIG_BYTES = int(os.getenv("TEST_OTEL_BIG_BYTES", str(100 * 1024)))
MAX_TOOL_SPANS = int(os.getenv("TEST_OTEL_MAX_TOOL_SPANS", "200"))


def _clip(v, n=2048):
    s = str(v)
    return s if len(s) <= n else s[:n] + "…"


class RunTelemetry:
    def __init__(self, suite, runner="pytest"):
        self.run_id = str(uuid.uuid4())
        self.t0 = time.perf_counter()
        resource = Resource.create({
            "service.name": os.getenv("OTEL_SERVICE_NAME", "myapp-tests"),
            "deployment.environment": "test",
            "telemetry.source": "test",
        })
        self.provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(
            endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                               "http://127.0.0.1:4318/v1/traces"),
            timeout=2,  # seconds; never let telemetry stall the run
        )
        self.provider.add_span_processor(BatchSpanProcessor(exporter, export_timeout_millis=2000))
        self.tracer = self.provider.get_tracer("test-harness")
        self.root = self.tracer.start_span("test run", attributes={
            "test.run.id": self.run_id, "test.origin": True,
            "test.suite": suite, "test.runner": runner,
        })
        self.ctx = trace.set_span_in_context(self.root)
        self.counts = {"passed": 0, "failed": 0, "skipped": 0}
        self.durations, self.failures = [], []
        self.tools, self.emitted, self.dropped = {}, 0, 0

    # ---- test results: roll up, never one span per test ----
    def record_test(self, nodeid, seconds, outcome, message=""):
        self.counts[outcome if outcome in self.counts else "failed"] += 1
        self.durations.append((seconds * 1000.0, nodeid))
        if outcome == "failed":
            self.failures.append((nodeid, _clip(message, 500)))

    # ---- tool calls: always measure, emit a span only if interesting ----
    @contextlib.contextmanager
    def tool_call(self, name, *, test=None, input_bytes=0, **detail):
        start_ns, t0 = time.time_ns(), time.perf_counter_ns()
        r = {"output_bytes": 0, "ok": True, "error": None}
        try:
            yield r                      # caller sets r["output_bytes"], r["ok"]
        except Exception as e:           # record, then re-raise unchanged
            r["ok"], r["error"] = False, f"{type(e).__name__}: {_clip(e, 500)}"
            raise
        finally:
            try:
                elapsed_ns = time.perf_counter_ns() - t0
                self._finish_tool(name, start_ns, start_ns + elapsed_ns,
                                  input_bytes, r, test, detail)
            except Exception:
                pass                     # telemetry must never fail a test

    def _finish_tool(self, name, start_ns, end_ns, in_bytes, r, test, detail):
        ms = (end_ns - start_ns) / 1e6
        out = int(r["output_bytes"])
        t = self.tools.setdefault(name, {"calls": 0, "total_ms": 0.0, "max_ms": 0.0,
                                         "total_out_bytes": 0, "max_out_bytes": 0})
        t["calls"] += 1; t["total_ms"] += ms; t["max_ms"] = max(t["max_ms"], ms)
        t["total_out_bytes"] += out; t["max_out_bytes"] = max(t["max_out_bytes"], out)

        reasons = [x for x, hit in (("slow", ms >= SLOW_MS),
                                    ("large", out >= BIG_BYTES),
                                    ("error", not r["ok"])) if hit]
        if not reasons:
            return
        if self.emitted >= MAX_TOOL_SPANS:
            self.dropped += 1
            return
        attrs = {
            "test.origin": True, "test.run.id": self.run_id,
            "tool.invoked_by": "test", "tool.name": name,
            "tool.emit_reason": ",".join(reasons),
            "tool.duration_ms": round(ms, 1),
            "tool.input.bytes": in_bytes, "tool.output.bytes": out,
        }
        if test:
            attrs["test.case.name"] = _clip(test, 500)
        for k, v in detail.items():      # short, redacted diagnostics only
            attrs[f"tool.detail.{k}"] = _clip(v, 500)
        span = self.tracer.start_span(f"tool {name}", context=self.ctx,
                                      kind=SpanKind.CLIENT, start_time=start_ns,
                                      attributes=attrs)
        if not r["ok"]:
            span.set_status(Status(StatusCode.ERROR, _clip(r["error"], 500)))
        span.end(end_time=end_ns)
        self.emitted += 1

    def child_env(self):
        """Environment for a child process so its spans join this trace."""
        carrier = {}
        inject(carrier, context=self.ctx)        # W3C traceparent / tracestate
        env = {"TEST_RUN_ID": self.run_id}
        if "traceparent" in carrier:
            env["TRACEPARENT"] = carrier["traceparent"]
        if "tracestate" in carrier:
            env["TRACESTATE"] = carrier["tracestate"]
        return env

    def finish(self, failed_or_error: bool):
        try:
            d = sorted(self.durations)
            pick = lambda q: round(d[min(len(d) - 1, int(q * len(d)))][0], 1) if d else 0
            top = sorted(self.durations, reverse=True)[:5]
            summary = sorted(self.tools.items(), key=lambda kv: -kv[1]["total_ms"])[:10]
            self.root.set_attributes({
                "test.total": sum(self.counts.values()),
                "test.passed": self.counts["passed"], "test.failed": self.counts["failed"],
                "test.skipped": self.counts["skipped"],
                "test.duration_ms": round((time.perf_counter() - self.t0) * 1000, 1),
                "test.case.duration_ms.p50": pick(0.50), "test.case.duration_ms.p95": pick(0.95),
                "test.case.duration_ms.max": pick(1.0) if d else 0,
                "test.slowest": [f"{n}={ms:.0f}ms" for ms, n in top],
                "test.tools.summary": _clip(json.dumps(dict(summary)), 8000),
                "test.tool_spans.emitted": self.emitted,
                "test.tool_spans.dropped": self.dropped,
            })
            for nodeid, msg in self.failures[:20]:
                self.root.add_event("test.failure", {"test.case.name": nodeid, "message": msg})
            if len(self.failures) > 20:
                self.root.set_attribute("test.failures.truncated", len(self.failures) - 20)
            if failed_or_error:
                self.root.set_status(Status(StatusCode.ERROR, "test failures"))
            self.root.end()
            self.provider.force_flush(timeout_millis=3000)
            self.provider.shutdown()
        except Exception:
            pass
```

`conftest.py` (hooks):

```python
from test_otel import RunTelemetry

RUN = None

def pytest_sessionstart(session):
    global RUN
    RUN = RunTelemetry(suite=session.config.rootpath.name)

def pytest_runtest_logreport(report):
    if RUN and (report.when == "call" or (report.when == "setup" and report.outcome != "passed")):
        RUN.record_test(report.nodeid, report.duration, report.outcome,
                        message=str(getattr(report, "longrepr", ""))[:500])

def pytest_sessionfinish(session, exitstatus):
    if RUN:
        RUN.finish(failed_or_error=exitstatus != 0)
```

Using it around a tool call:

```python
import json, os
from conftest import RUN

def call_tool(name, args):
    with RUN.tool_call(name, test=os.environ.get("PYTEST_CURRENT_TEST"),
                       input_bytes=len(json.dumps(args)),
                       arg_keys=",".join(sorted(args))) as r:
        out = real_tool_call(name, args)       # your real call
        r["output_bytes"] = len(out)
        return out
```

### 4.3 JavaScript / TypeScript helper (runner-agnostic)

Set up the provider and exporter as your SDK version documents (the SDK
setup API changed between major versions). The span logic below uses only the
stable `@opentelemetry/api`:

```js
const { trace, context, propagation, SpanKind, SpanStatusCode } = require('@opentelemetry/api');

const SLOW_MS = Number(process.env.TEST_OTEL_SLOW_MS ?? 1000);
const BIG_BYTES = Number(process.env.TEST_OTEL_BIG_BYTES ?? 100 * 1024);
const MAX_TOOL_SPANS = Number(process.env.TEST_OTEL_MAX_TOOL_SPANS ?? 200);
const clip = (v, n = 2048) => { const s = String(v); return s.length <= n ? s : s.slice(0, n) + '…'; };

function startRun(tracer, runId, suite) {
  const root = tracer.startSpan('test run', {
    attributes: { 'test.run.id': runId, 'test.origin': true, 'test.suite': suite },
  });
  return { tracer, root, runId, ctx: trace.setSpan(context.active(), root),
           tools: new Map(), emitted: 0, dropped: 0 };
}

// Call AFTER the tool call finished. startMs is epoch milliseconds (Date.now() before the call).
function recordToolCall(run, { name, startMs, durationMs, inputBytes = 0, outputBytes = 0,
                               ok = true, error, testName, detail = {} }) {
  try {
    const t = run.tools.get(name) ?? { calls: 0, total_ms: 0, max_ms: 0, total_out_bytes: 0, max_out_bytes: 0 };
    t.calls++; t.total_ms += durationMs; t.max_ms = Math.max(t.max_ms, durationMs);
    t.total_out_bytes += outputBytes; t.max_out_bytes = Math.max(t.max_out_bytes, outputBytes);
    run.tools.set(name, t);

    const reasons = [];
    if (durationMs >= SLOW_MS) reasons.push('slow');
    if (outputBytes >= BIG_BYTES) reasons.push('large');
    if (!ok) reasons.push('error');
    if (!reasons.length) return;
    if (run.emitted >= MAX_TOOL_SPANS) { run.dropped++; return; }

    const attributes = {
      'test.origin': true, 'test.run.id': run.runId, 'tool.invoked_by': 'test',
      'tool.name': name, 'tool.emit_reason': reasons.join(','),
      'tool.duration_ms': Math.round(durationMs * 10) / 10,
      'tool.input.bytes': inputBytes, 'tool.output.bytes': outputBytes,
    };
    if (testName) attributes['test.case.name'] = clip(testName, 500);
    for (const [k, v] of Object.entries(detail)) attributes[`tool.detail.${k}`] = clip(v, 500);

    const span = run.tracer.startSpan(`tool ${name}`,
      { kind: SpanKind.CLIENT, startTime: startMs, attributes }, run.ctx);
    if (!ok) span.setStatus({ code: SpanStatusCode.ERROR, message: clip(error, 500) });
    span.end(startMs + durationMs);
    run.emitted++;
  } catch { /* telemetry must never fail a test */ }
}

// For a child process: propagate the trace through the environment.
function childEnv(run) {
  const carrier = {};
  propagation.inject(run.ctx, carrier);
  return { TEST_RUN_ID: run.runId,
           ...(carrier.traceparent && { TRACEPARENT: carrier.traceparent }),
           ...(carrier.tracestate && { TRACESTATE: carrier.tracestate }) };
}
```

At the end of the run, set the roll-up attributes on `run.root` exactly as in
section 2.1, end it, then flush and shut down the provider.

## 5. Correlation and labeling

- **Same trace.** Every tool span is created with the run span's context as
  its parent, so they all share one trace ID. In any trace viewer, opening
  the run span shows its tool spans underneath it.
- **Belt and braces:** every span also has `test.run.id`, which you can query
  on even if the backend does not link by trace ID.
- **Child processes.** If the thing under test is a separate process (a CLI, a
  server started by the tests), pass the trace context in the environment:
  `TRACEPARENT` (and `TRACESTATE`). A process that reads these at start-up
  and parents its own spans to them will appear in the same trace. This is
  the OpenTelemetry convention for environment-variable propagation. Check
  that your language's SDK supports it, or read the variable and extract the
  context yourself. Apply the **same thresholds** inside the application, or a
  long run will flood the collector from that side.
- **Labeling.** Test-originated data is identifiable three ways: the
  resource (`service.name = <app>-tests`, `telemetry.source = test`), the span
  attribute `test.origin = true`, and `tool.invoked_by = test`. The
  application's own server-side spans keep the application's `service.name`,
  so you can separate "what the test measured" from "what the application did".

## 6. Metrics, sampling and cardinality

- **Spans are for outliers; metrics are for distributions.** Because fast calls
  deliberately get no span, any metric *derived from the spans* (for example by
  the collector's `spanmetrics` connector) only describes slow, large or
  failed calls. It will look worse than reality and its call counts will be
  wrong. If you want unbiased duration and size distributions, have the
  harness record **OTel metrics for every call** (a duration metric and an
  output-bytes metric, with `tool.name` as an attribute).
- **Keep metric attributes bounded.** An attribute multiplies the number of
  series by its number of distinct values. A test file path or a tool name is
  bounded by the size of your suite, so it is fine, and DX O2 can group and
  filter on it (Part 2 shows how). **Never** use run IDs, timestamps or other
  unbounded values as metric attributes. For per-test names, send the metric
  **only for tests above your time threshold**, so the series count stays small.
  Run IDs and the like belong on spans only.
- **Which metrics does the dashboard need?** Part 2 defines a small set of
  `test.*` metrics (per-run totals, per-file durations, slow per-test durations)
  that feed a "Test Time" dashboard. Send them in addition to the spans.
- **Why not just sample?** Head sampling decides before the call and cannot
  know the duration. Tail sampling in the collector can use latency and error
  policies, but only after every span has been sent and buffered, which is
  exactly the flood you are trying to avoid. Filter at the source; use tail
  sampling at most as a second line of defence.

## 7. Configuring the collector to receive the spans

A minimal, working OpenTelemetry Collector configuration (contrib
distribution). It receives OTLP from the harness, protects itself, tags and
trims the spans, and exports them. Save as `otelcol.yaml`.

```yaml
extensions:
  health_check:
    endpoint: 127.0.0.1:13133

receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318     # harness default
      grpc:
        endpoint: 127.0.0.1:4317

processors:
  memory_limiter:                    # always first
    check_interval: 1s
    limit_mib: 256
    spike_limit_mib: 64

  resource/test:                     # make sure test data is labeled even if a harness forgets
    attributes:
      - key: deployment.environment
        value: test
        action: upsert

  transform/clip:                    # hard cap on attribute length
    error_mode: ignore
    trace_statements:
      - context: span
        statements:
          - truncate_all(attributes, 2048)

  batch:
    timeout: 5s
    send_batch_size: 512

exporters:
  debug:                             # prints what arrives; use "basic" once it works
    verbosity: detailed

  otlphttp/backend:                  # your tracing backend (see appendix for DX O2)
    endpoint: ${env:BACKEND_OTLP_ENDPOINT}     # base URL; /v1/traces is appended
    headers:
      Authorization: "Bearer ${env:BACKEND_TOKEN}"
    timeout: 10s
    retry_on_failure:
      enabled: true
      max_elapsed_time: 60s
    sending_queue:
      enabled: true
      queue_size: 500

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource/test, transform/clip, batch]
      exporters: [otlphttp/backend, debug]
```

Start it with `otelcol-contrib --config otelcol.yaml`. Provide the token and
endpoint through environment variables (`BACKEND_OTLP_ENDPOINT`,
`BACKEND_TOKEN`), **never** by writing them into the file. Check the syntax
alone with `otelcol-contrib validate --config otelcol.yaml`.

### 7.1 Optional pieces

**Drop test spans from a production pipeline**, if test and production data
share a collector:

```yaml
processors:
  filter/drop-test:
    error_mode: ignore
    traces:
      span:
        - 'attributes["test.origin"] == true'
```

Put it in the *production* pipeline's `processors` list, and use a separate
pipeline (without it) for test data.

**Tail sampling** as defence in depth (needs the contrib build). With harness
filtering you usually do not need it. If you do, keep every trace that is
slow, failed, or from a test run, and sample the rest:

```yaml
processors:
  tail_sampling:
    decision_wait: 15s
    num_traces: 5000
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 1000 }
      - name: test-runs
        type: string_attribute
        string_attribute: { key: telemetry.source, values: [test] }
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
```

Place `tail_sampling` after `memory_limiter` and before `batch`. Remember its
caveat: every span still crosses the wire to the collector first.

**Metrics derived from spans** (the `spanmetrics` connector) are available, but
read section 6 first: they only see the spans you emitted. If you use them, use
low-cardinality dimensions only (`tool.name`), never `test.case.name`.

### 7.2 Check that it works, without running any tests

With the collector running (and the `debug` exporter on), post one hand-made
span to the OTLP/HTTP receiver:

```bash
curl -sS -X POST http://127.0.0.1:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[
        {"key":"service.name","value":{"stringValue":"myapp-tests"}},
        {"key":"telemetry.source","value":{"stringValue":"test"}}]},
      "scopeSpans":[{"scope":{"name":"manual"},"spans":[{
        "traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174",
        "name":"test run","kind":1,
        "startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000002000000000",
        "attributes":[
          {"key":"test.run.id","value":{"stringValue":"demo"}},
          {"key":"test.origin","value":{"boolValue":true}}]}]}]}]}'
```

A reply of `{"partialSuccess":{}}` means the collector accepted it, and the
collector's console should print the span. Then run your tests once and look
for: one `test run` span carrying the roll-up attributes, tool spans nested
under it (only if something crossed a threshold), and `test.tool_spans.dropped`
equal to `0`.

If nothing arrives: confirm the harness points at the same host and port
(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is the **full** URL including
`/v1/traces`; `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL), and that the
process flushed before exiting. Short runs that exit without a flush are the
most common reason for "no spans".

## 8. Checklist

- [ ] One `test run` span per run, with roll-up attributes and failure events.
- [ ] No span per test case.
- [ ] Every tool call measured; spans only for slow, large or failed calls.
- [ ] Thresholds and the per-run cap come from environment variables.
- [ ] Tool spans are children of the run span and carry `test.run.id`.
- [ ] Everything labeled `test.origin = true`; distinct `service.name`.
- [ ] Child processes get `TRACEPARENT` and apply the same thresholds.
- [ ] Strings truncated and redacted; no secrets or bodies on spans.
- [ ] Short export timeout, bounded flush, telemetry never fails a test.
- [ ] Collector: `memory_limiter` first, `batch` last, token from the environment.
- [ ] Verified with the hand-made span in 7.2.

## Appendix: using DX O2 as the backend

These are notes for one specific backend, kept out of the main text.

- **Endpoint.** Your tenant's connector configuration lists the OTLP gateway.
  For the `dxi-na1` region it shows an HTTP endpoint
  `https://otel-gateway.dxi-na1.saas.broadcom.com` and a gRPC endpoint
  `otel-gateway.dxi-na1.saas.broadcom.com:443`. For another region, use the one
  your own connector configuration shows. In the collector, set
  `BACKEND_OTLP_ENDPOINT` to the HTTP one for the `otlphttp` exporter.
- **Authentication.** An **Agent token** from your tenant, sent as
  `Authorization: Bearer <token>`. Supply it via `BACKEND_TOKEN` in the
  environment. Do not put it in the configuration file or the repository.
- **Attribution.** DX O2 attributes data to an agent using resource
  attributes: `service.name` plus one of `host.name` or `k8s.pod.name`. Add
  `host.name` in the harness or in the `resource/test` processor, or the data
  may not be attributed. An optional `broadcomAgentTriplet` resource attribute
  lets you choose the agent name explicitly.
- **Every pipeline that exports to DX O2** needs the resource processor, or the
  data is not attributed to an agent.
- **Metrics from spans** need delta temporality
  (`aggregation_temporality: "AGGREGATION_TEMPORALITY_DELTA"` on the
  `spanmetrics` connector). Keep metric attributes **bounded** (see section 6).
  In a live tenant, data-point attributes were **not** part of the metric path:
  series that differ only by attributes share one path and are told apart by
  their attributes, which NASSQL reads as `metric.attr.<name>` columns. By
  contrast, the **span name** of a span-derived metric *is* a branch of the
  tree, so keep span names stable.
- These points summarise the DX O2 OpenTelemetry ingestion documentation as
  recorded in an earlier internal note. Check them against the current
  documentation before relying on them. Size limits, rate limits and retry
  behaviour were not stated there, so treat them as unknown.
