# Knowledge Graph Patterns

The memory module's API surface is documented in [MEMORY.md](MEMORY.md) — this
doc covers how to *use* it well. The API is small on purpose: four primitives
(entities, episodes, evidence, links) plus a single query endpoint that
dispatches to nine different modes based on which fields are set. Most of the
leverage comes from a few conventions that aren't enforced by the schema.

## Mental model

```
 entity ─────┐
             │              evidence ──┬─▶ entity
 entity ◀──▶ │ link                    │
             │                         └─▶ episode
 episode ────┤
             ▶ entities (via episode_entities.role)
```

**Entities** are nouns: people, projects, markets, documents. Stable identity,
evolving attributes. SQL is the source of truth.

**Episodes** are events: something happened at a point in time. Immutable once
written. Link to one or more entities via `entityRoles`.

**Evidence** is the citation layer: URLs, document references, snippets that
justify a claim. Attach to entities ("why do we think this person works at
Acme?") and episodes ("what source did this decision come from?").

**Links** are relationships in the AGE graph: `OWNS`, `WORKS_AT`, `DEPENDS_ON`.
Entity-to-entity only. Edges have properties and optional `validFrom`/`validUntil`
for temporal edges.

**Provenance** is a single-value `varchar(255)` on entities *and* episodes. In
practice it's used as a **workflow tag** — the name of the job that wrote the
row — not a URL. Citations go in `evidence`.

## Entity modeling

### Stable name, fluid attributes

Entity `name` is the human-readable identifier and should be stable. Everything
mutable goes in `attributes` (JSONB).

```json
{"type": "project", "name": "Gatekeeper",
 "attributes": {"status": "active", "version": "0.3.2", "stars": 412}}
```

Renaming is supported (`memory.upsert` with `id`), but downstream queries that
used `entityName` will break, so treat renames as migrations.

### Use existing types before inventing new ones

`entityTypes` is a closed enum: `person`, `organization`, `project`, `concept`,
`place`, `event`, `document`, `prediction_market`, `thesis`. Adding a new type
requires a schema change and a migration. For most needs, pick the closest
existing type and put the specialization in `attributes`:

```json
// Not a new type — a project with attributes
{"type": "project", "name": "RecallRadar",
 "attributes": {"subtype": "saas", "stage": "pre-launch"}}
```

### Confidence is not probability

`confidence` (0.0–1.0) is a source-quality hint, not a calibrated probability.
Convention:

- `1.0` — directly asserted by a trusted source (user, canonical data)
- `0.8` — extracted from a high-quality source (official docs)
- `0.5` — inferred from noisy sources (news, social)
- `< 0.5` — explicitly marked as speculative

Most consumers just check `confidence >= 0.5`.

## Episodes: the workhorse

Episodes carry more weight than most users expect. They're where you log **what
happened**, which is what queries actually want to know.

### The entityRoles map

`entityRoles` maps entity IDs to their role in this episode. Standard roles:

- `subject` — what the episode is about
- `object` — what was acted upon
- `agent` — who performed the action
- `witness` — who observed it
- `source` — where the information came from

```json
{
  "type": "decision",
  "summary": "Chose Postgres over DynamoDB for audit sink",
  "entityIds": ["<gatekeeper-id>", "<evan-id>"],
  "entityRoles": {
    "<gatekeeper-id>": "subject",
    "<evan-id>": "agent"
  }
}
```

The role isn't used by policy or indexes — it's a convention for humans and
downstream queries.

### Importance is for filtering, not sorting

`importance` (0.0–1.0) exists so `minImportance: 0.7` can skip routine events
when you're asking "what were the big decisions last month." It's not a
priority queue. Default is 0.5. Reserve `> 0.8` for things you'd bring up in a
retrospective.

### Details is open JSON — use it

`details` is a JSONB bag. Put structured context there, not in `summary`.
Downstream `detailsContain` queries are fast when you use flat keys:

```json
{
  "type": "event",
  "summary": "Labs drawn",
  "details": {
    "category": "lab",
    "testName": "Glucose",
    "value": 95,
    "unit": "mg/dL",
    "abnormalFlag": false
  },
  "provenance": "cerbo-sync"
}
```

Then: `{ "detailsContain": {"category": "lab", "abnormalFlag": true} }` returns
only abnormal labs, using Postgres's `@>` operator on the JSONB column.

## Provenance as a workflow tag

The `provenance` field is short (`varchar(255)`) and singular, which rules out
citation URLs. The convention is to put the **name of the process that wrote
the row**:

| Provenance value | What wrote it |
|---|---|
| `daily-lens` | Morning summary workflow |
| `cgm-sync` | Continuous glucose monitor ingest |
| `cerbo-sync` | Clinical records import |
| `pm-thesis-research` | Prediction-market thesis generator |
| `signal-monitor` | Paper-trade signal detector |
| `manual` | Human-entered via dashboard |

This lets you answer "which workflow produced this?" without joining tables,
and enables the `notProvenance` filter (below).

## notProvenance: separating content from telemetry

A memory graph that's ingesting CGM readings every 5 minutes will have
thousands of low-signal episodes per day. When you query "what happened last
week?", you want *content*, not telemetry.

`notProvenance` is the escape valve:

```json
{
  "episodeType": "observation",
  "since": "2026-04-14T00:00:00Z",
  "notProvenance": ["cgm-sync", "health-tracking", "portfolio-sync"],
  "limit": 50
}
```

Without the filter, the top 50 would be dominated by glucose readings. With it,
you see research notes, decisions, and interactions.

**Tradeoff:** this requires you to tag telemetry with a consistent provenance
at write time. If your telemetry writer forgets, it drifts back into content
queries. Treat the provenance list as infrastructure, not documentation.

## Evidence: the citation layer

Evidence is where URLs and document references live — not the `provenance`
field.

```json
{
  "type": "url",
  "reference": "https://example.com/2026-launch-announcement",
  "snippet": "Gatekeeper v0.4 ships Q3 2026...",
  "taint": ["external"],
  "entityIds": ["<gatekeeper-id>"],
  "episodeIds": ["<launch-episode-id>"]
}
```

An evidence row can link to multiple entities and episodes via
`evidence_links`. Query back via `memory.query` with `evidenceForEntity` or
`evidenceForEpisode`.

### Taint on evidence

The `taint` array on evidence is load-bearing for downstream trust decisions.
Convention: tag anything that came from outside your trusted boundary
(`external`, `email`, `untrusted`). Consumers of evidence can filter or
down-weight tainted rows.

## Query modes: which field wins

`memory.query` is one endpoint with nine dispatch modes. The server picks the
first one whose trigger fields are present, **in this order**:

1. **Evidence lookup** — `evidenceForEntity` or `evidenceForEpisode`
2. **Raw Cypher** — `cypher`
3. **Entity by ID** — `entityId`
4. **Entity by exact name** — `entityName`
5. **Full-text search** — `searchText`
6. **Entity by type** — `entityType`
7. **Attribute containment** — `attributeQuery`
8. **Neighborhood traversal** — `fromEntity`
9. **Episode filters** — any of `episodeType`, `minImportance`, `since`,
   `until`, `provenance`, `notProvenance`, `detailsContain`

If you set two fields from different modes (e.g. `entityId` *and*
`attributeQuery`), the server uses whichever comes first in the list above and
silently ignores the rest. This is not an error.

**Practical consequence:** if you're debugging "why did my query return the
wrong thing?", check the response's `type` field — it tells you which mode ran.

## Cypher: two gotchas

If you drop to raw Cypher for a traversal the built-in modes can't express:

1. **Single-column return.** AGE's `cypher()` wrapper requires your `RETURN`
   to project exactly one column. Use a map to aggregate:

   ```cypher
   MATCH (a)-[r]->(b)
   RETURN {source: a.id, relation: type(r), target: b.id}
   ```

   Not:
   ```cypher
   MATCH (a)-[r]->(b) RETURN a, r, b  -- fails
   ```

2. **Entity stubs only.** The graph side stores entity nodes as stubs
   (`:Entity {id: <uuid>}`) with no attributes. If you need the name or type,
   fetch from SQL after traversal, or pass through `memory.query` with
   `entityId`.

## The no-delete model

There is no `memory.delete`. Entities update-in-place via
`memory.upsert({id, ...})`; episodes and evidence are append-only at the API
level.

This is intentional: audit integrity and provenance forensics depend on the
row not vanishing. If you need to "correct" a memory, the pattern is:

1. Write a new episode with `type: "correction"` that references the old one
   in `details.correctsEpisodeId`.
2. Update the entity's `attributes` if the correction affects current state.
3. Consumers filter out episodes with a `correctsEpisodeId` set.

### Consolidation ledger pattern

When ingesting a stream (RSS, news, activity logs), you'll want to deduplicate
across runs without hitting the database for every check. The consolidation
ledger pattern:

1. Maintain a local JSON file (`data/consolidation-ledger.json`) mapping
   external IDs → internal entity/episode IDs already written.
2. Before calling `memory.upsert` / `memory.episode`, check the ledger.
3. On successful write, append the external ID → internal ID mapping.
4. The ledger is the single source of truth for "have I already consolidated
   this?"

This is what runestone-assistants uses for daily-lens ingestion. The
gatekeeper doesn't ship it (it's a consumer concern), but the schema supports
it because there's no delete path to compete with.

## When to use SQL vs graph

The hybrid storage is a feature, not a compromise. Pick the side that matches
your query:

| Query shape | Use | Why |
|---|---|---|
| "Give me the full record for entity X" | SQL (`entityId`) | Attributes live in SQL |
| "Which entities of type 'project' are active?" | SQL (`entityType` + `attributeQuery`) | Indexed scans |
| "Full-text search on name/description" | SQL (`searchText`) | tsvector indexed |
| "All entities within 2 hops of X" | Graph (`fromEntity`) | Traversal is what graphs are for |
| "All paths between X and Y" | Cypher | Only graph can express this |
| "Episodes with details.category = 'lab'" | SQL (`detailsContain`) | JSONB containment |

**Rule of thumb:** if the answer is a table, use SQL. If the answer requires
traversing relationships, use the graph.

## Writing episodes that query well

A few habits that pay off:

- **Lead with `type`.** `decision`, `event`, `observation`, `interaction`,
  `milestone` — pick one consistently. `episodeType` filters are the fastest
  way to slice history.
- **Fill `occurredAt` explicitly** for backfilled data. Defaults to now,
  which breaks `since`/`until` windows when you're importing old records.
- **Put the stable fact in `summary`, the context in `details`.** Summary is
  what shows up in lists; details is what you drill into.
- **Set `provenance` on every write.** Cost is one string, value is the
  `notProvenance` filter.
- **Link entities at write time.** Post-hoc linking requires a separate
  `memory.link` call and loses the episode-level role info.

## Evidence chains in practice

A research workflow that tracks *why* it believes things:

```
1. memory.upsert({type: "thesis", name: "Polymarket 2028 outcome",
                  attributes: {score: 0.62}, provenance: "pm-thesis-research"})
   → thesis-id

2. memory.episode({type: "decision",
                   summary: "Assigned score 0.62 based on 3 news items",
                   entityIds: [thesis-id],
                   entityRoles: {[thesis-id]: "subject"},
                   details: {model: "claude-opus-4-7", inputs: 3},
                   provenance: "pm-thesis-research"})
   → episode-id

3. For each news URL:
   memory.evidence({type: "url", reference: url, snippet: headline,
                    entityIds: [thesis-id], episodeIds: [episode-id],
                    taint: ["external"], relevance: 0.7})
```

Then later: `memory.query({evidenceForEntity: thesis-id})` returns the three
news items that drove the score. The score lives on the entity, the decision
lives on the episode, and the reasoning lives in evidence — three separate
tables, one causal chain.

## See also

- [MEMORY.md](MEMORY.md) — API reference for the six memory tools
- [POLICY_GUIDE.md](POLICY_GUIDE.md) — tool-level access control
- [API.md](API.md) — HTTP surface
