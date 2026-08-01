# Observability baseline

The composition layer should expose `PrometheusMetrics.render()` from an internal
HTTP endpoint such as `/internal/metrics`. Do not make this endpoint public.

The metric API only accepts bounded operational labels. Meeting, recording,
speaker, guild, channel, job, tenant, and request identifiers belong in redacted
JSON logs as fields and must never be added as metric labels.

Use the OpenMetrics content type when calling `render("openmetrics")`; otherwise
use the Prometheus 0.0.4 content type exported by the adapter.

`prometheus.sample.yml` is a local/example scrape configuration. Production
service discovery, authentication, TLS, retention, and alert routing remain
deployment-owned.
