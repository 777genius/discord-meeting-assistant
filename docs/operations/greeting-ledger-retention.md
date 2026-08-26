# Greeting operational-ledger retention

## Ownership and bound

Meeting Platform owns derived greeting obligations. The PostgreSQL adapter owns
their storage and the meeting-scoped capacity-admission fence. Operations owns
the scheduled maintenance invocation and its audit record.

Run `DerivedGreetingTerminalRetention` at least daily with batches of at most
100 meetings until it reports zero processed meetings. Its fixed cutoff is 90
days. Alert the Meeting Platform owner if eligible rows remain for seven days;
the operational database must not carry eligible rows beyond 97 days.

This is operational retention, not campaign-evidence retention. The maintenance
port never deletes `conversation_one_shot_receipts`, provider-start timestamps,
recordings, transcripts, meeting snapshots, or retained campaign artifacts.

## Eligibility and fail-closed rules

The adapter may delete rows only when all of these conditions hold:

1. the durable live-meeting snapshot is `ended` and was last updated before the
   cutoff;
2. a derived obligation is `delivered` or `expired`, has a terminal timestamp,
   and that timestamp is before the cutoff;
3. every receipt referenced by a meeting's capacity-admission scope exists and
   is `played` or `suppressed`.

Any `active` meeting, pending obligation, missing receipt, or receipt in
`reserved`, `commanded`, or `started` state fails closed and remains untouched.
The adapter removes capacity admissions only after the entire scope passes that
check, so cleanup cannot reopen capacity during a meeting. Receipt rows remain
the durable playback/provider-start evidence after their operational fences are
removed.

## Operating procedure

Before enabling or changing the scheduled invocation:

1. run the PostgreSQL greeting integration regression on a disposable database;
2. record the exact application and migration revisions;
3. take a database backup according to the deployment's existing recovery
   policy;
4. run one batch and record its cutoff, meetings processed, obligations deleted,
   and capacity admissions deleted;
5. confirm pending obligation count and every non-terminal receipt count are
   unchanged; stop and investigate on any mismatch;
6. continue bounded batches only while each result is internally consistent.

Do not run cleanup during a private-guild campaign or evidence collection. A
campaign hold delays operational cleanup; it never authorizes deletion of the
evidence rows themselves. This repository's local tests prove only the
application/adapter safety contract and do not prove that any deployment has
scheduled or executed retention.
