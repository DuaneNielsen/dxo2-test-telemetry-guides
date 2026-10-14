# Test telemetry for DX O2: guides and examples

How to make a test harness report how a test run went to DX O2 (Broadcom DX
Operational Observability), without flooding your collector, and how to build a
**Test Time dashboard** from JSON with plain `curl`.

Two guides and three small, dependency-free scripts. Everything that was run
against a live DX O2 tenant is marked as tested; everything that was not is
marked too.

## What you get

- **A reporting strategy.** One summary span per test run. Spans for tool calls
  only when they are slow, large or failed. Every call still measured and rolled
  up. A per-run cap. Correlation with the run, and labels that keep test traffic
  apart from production.
- **A metric contract.** The few `test.*` metrics a harness sends so DX O2 can
  chart a run (runs, passed, failed, durations per run, per file and per slow test).
- **A dashboard you can create from a script.** Five tiles, a file status map,
  a slowest-tests table and a top-files table, built with NASSQL queries and
  posted to the API with `curl`.
- **A reference harness** that runs `node:test` files and sends those metrics.

## Start here

1. Read [Part 1, section 1](otel-test-harness-guide.md#1-the-strategy-in-one-page)
   (one page): the strategy.
2. Read [Part 2, section 1](dxo2-test-dashboard-guide.md#1-the-metric-contract-what-the-harness-sends):
   the metrics your harness must send, and the one rule below.
3. Get data in. Either run your own tests through the reference harness, or send
   made-up runs with the sample sender (see the commands below).
4. Generate the dashboard and create it with `curl`
   ([Part 2, section 4](dxo2-test-dashboard-guide.md#4-building-the-dashboard-from-json)).
5. If a panel shows "No data", follow
   [Part 2, section 5](dxo2-test-dashboard-guide.md#5-if-a-panel-shows-no-data).

## The one rule that bites

**DX O2 keeps one value per series per minute.** If several points for the same
series arrive in the same minute, it stores *number of points x the last value*,
not their sum. Send one point per series per run, and keep runs of the same suite
more than a minute apart (or add their values yourself first). Details and the
evidence are in [Part 2, section 1.1a](dxo2-test-dashboard-guide.md#11a-the-most-important-rule-one-point-per-series-per-minute).

## Files

| File | What it is | Status |
|---|---|---|
| [`otel-test-harness-guide.md`](otel-test-harness-guide.md) | **Part 1.** The strategy: what goes on the run span and on tool spans, why spans are created after the call, thresholds and caps, correlation and labelling, metrics and cardinality, a collector configuration, a checklist. | Design and reasoning. **The code in it has not been run** (see Status). |
| [`dxo2-test-dashboard-guide.md`](dxo2-test-dashboard-guide.md) | **Part 2.** What DX O2 needs on the data, the `test.*` metric contract, the `curl` API calls, NASSQL, the dashboard JSON, troubleshooting, and a list of what was and was not tested. | API calls, queries, dashboard and scripts tested on a live tenant. |
| [`examples/make-test-time-dashboard.js`](examples/make-test-time-dashboard.js) | Builds the request body for the Test Time dashboard from your agent name. No dependencies. | Tested: its output was compared with a working dashboard, and a fresh session built the dashboard from the guide with it. |
| [`examples/run-tests-with-otel.mjs`](examples/run-tests-with-otel.mjs) | Reference harness: runs `node:test` files in parallel, prints a summary and the slowest tests, and sends the `test.*` metrics in one request. `--dry-run` sends nothing. | Tested against a real 72-file suite; the results appeared on the dashboard. |
| [`examples/send-sample-test-metrics.mjs`](examples/send-sample-test-metrics.mjs) | Sends made-up test runs, one per minute, so you can see the dashboard working before your own harness is ready. | Tested on a live tenant. |

## Using the scripts

You need Node.js 20 or newer. The scripts have no dependencies.

```bash
# 1. Generate the dashboard request body
node examples/make-test-time-dashboard.js --agent "MyTests|my-test-agent" --out dashboard.body.json

# 2. See what the sample sender would do, then send six made-up runs (takes about 6 minutes)
node examples/send-sample-test-metrics.mjs --triplet "myhost|TestHarness|sample-runs" --dry-run
node examples/send-sample-test-metrics.mjs --triplet "myhost|TestHarness|sample-runs" --token-env DXO2_AGENT_TOKEN

# 3. Run your own tests through the harness (read the summary first, then drop --dry-run)
node examples/run-tests-with-otel.mjs --dry-run --triplet "myhost|MyTests|my-test-agent" \
     --project-root "myproject=/path/to/project" /path/to/project/tests/a.test.mjs
```

Creating the dashboard, querying, and cleaning up are `curl` calls, shown in
[Part 2, section 2](dxo2-test-dashboard-guide.md#2-calling-the-dx-o2-api-with-curl).

## What you need

- A DX O2 tenant, with **two kinds of token**: a **user token** to create
  dashboards and run queries, and an **agent token** to send metrics. Keep both in
  environment variables; never put them in a script, a file or this repository.
- Node.js 20 or newer for the example scripts.
- Optional: an OpenTelemetry Collector, if you also send spans (Part 1, section 7).

## Status: what was and was not tested

**Tested on a live tenant:** the NASSQL, dashboard create, overwrite and delete
calls; the generated dashboard (rendered with real data); sending the metrics to
the OTLP gateway with an agent token; the "one point per series per minute"
behaviour; and the three example scripts.

**Not tested:** the Python and JavaScript helpers and the collector
configuration in Part 1; the Python emitter in Part 2, section 1.5; deriving the
metrics in a collector instead of in the harness; duplicate-uid behaviour;
template variables; limits on size and rate. [Part 2, section 6](dxo2-test-dashboard-guide.md#6-what-was-and-was-not-tested)
has the full list.

## Safety notes

- `send-sample-test-metrics.mjs` and `run-tests-with-otel.mjs` (without
  `--dry-run`) **write data to your tenant**. Use a **new agent name** for samples,
  so they cannot mix with real data. Metrics cannot be deleted once sent.
- The test harness runs your tests with a throw-away home directory and with every
  environment variable that looks like a secret removed, but it still **runs your
  tests**: choose the files deliberately.
- API responses contain your cohort ID inside dashboard URLs. Redact them before
  sharing output.

## License

[MIT](LICENSE). These are how-to guides and small example scripts; use them freely.

This is an independent, unofficial guide. DX O2 is a Broadcom product, and
this repository is not Broadcom documentation.
