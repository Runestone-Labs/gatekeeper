# Memory System

Graph-based persistent memory for AI assistants using PostgreSQL with Apache AGE extension.

## Overview

The memory system enables agents to:
- **Store entities** (people, projects, concepts, etc.) in SQL
- **Create relationships** between entities in a graph database
- **Log episodes** (decisions, events, observations) over time
- **Query** both structured data and graph traversals

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Memory Tools                          │
├─────────────────────────────────────────────────────────┤
│  memory.upsert  → SQL (entities table)                  │
│  memory.link    → AGE Graph (relationships)             │
│  memory.query   → SQL + Cypher                          │
│  memory.episode → SQL (episodes table)                  │
│  memory.evidence → SQL (evidence + links)               │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              PostgreSQL + Apache AGE                     │
├─────────────────────────────────────────────────────────┤
│  SQL Tables (Drizzle ORM):                              │
│  - entities      (source of truth)                      │
│  - episodes      (temporal events)                      │
│  - episode_entities (links)                             │
│  - evidence      (supporting sources)                   │
├─────────────────────────────────────────────────────────┤
│  AGE Graph:                                              │
│  - Entity stub nodes (just IDs)                         │
│  - Relationship edges (OWNS, KNOWS, WORKS_AT, etc.)     │
└─────────────────────────────────────────────────────────┘
```

**Why this hybrid approach?**
- SQL for entities ensures ACID transactions and easy querying
- Graph for relationships enables powerful traversals (e.g., "find all projects 2 hops from Evan")
- No dual-write consistency issues since entities live only in SQL

## Quick Start

### Prerequisites

1. PostgreSQL with Apache AGE extension
2. Set `DATABASE_URL` environment variable

```bash
# Using Docker (recommended)
docker run -d \
  --name runestone-memory \
  -e POSTGRES_USER=runestone \
  -e POSTGRES_PASSWORD=runestone_dev \
  -e POSTGRES_DB=memory \
  -p 5433:5432 \
  apache/age:release_PG16_1.6.0

# Initialize AGE and create graph
docker exec runestone-memory psql -U runestone -d memory -c "
  CREATE EXTENSION IF NOT EXISTS age;
  LOAD 'age';
  SET search_path = ag_catalog;
  SELECT create_graph('memory_graph');
"

# Set environment variable
export DATABASE_URL="postgresql://runestone:runestone_dev@127.0.0.1:5433/memory"
```

### Basic Usage

```bash
# Create an entity
curl -X POST http://127.0.0.1:3847/tool/memory.upsert \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "550e8400-e29b-41d4-a716-446655440001",
    "actor": {"type": "agent", "name": "my-agent", "role": "openclaw"},
    "args": {
      "type": "person",
      "name": "Alice",
      "description": "Software engineer"
    }
  }'

# Query the entity
curl -X POST http://127.0.0.1:3847/tool/memory.query \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "550e8400-e29b-41d4-a716-446655440002",
    "actor": {"type": "agent", "name": "my-agent", "role": "openclaw"},
    "args": {"entityName": "Alice"}
  }'
```

---

## Memory Tools

### memory.upsert

Create or update an entity in SQL.

**Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID | No | If provided, updates existing entity |
| `type` | enum | Yes | `person`, `organization`, `project`, `concept`, `place`, `event`, `document` |
| `name` | string | Yes | Entity name (max 255 chars) |
| `description` | string | No | Longer description |
| `attributes` | object | No | Arbitrary key-value pairs |
| `confidence` | number | No | 0.0-1.0, default 1.0 |
| `provenance` | string | No | Source of information (max 255 chars) |

**Example - Create:**
```json
{
  "args": {
    "type": "project",
    "name": "Gatekeeper",
    "description": "Policy-based agent governance",
    "attributes": {
      "language": "TypeScript",
      "status": "active"
    },
    "confidence": 1.0,
    "provenance": "github.com/runestone-labs/gatekeeper"
  }
}
```

**Example - Update:**
```json
{
  "args": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "type": "project",
    "name": "Gatekeeper",
    "attributes": {
      "language": "TypeScript",
      "status": "active",
      "version": "0.2.0"
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "action": "created",
    "entity": {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "type": "project",
      "name": "Gatekeeper",
      "description": "Policy-based agent governance",
      "attributes": {"language": "TypeScript", "status": "active"},
      "confidence": 1,
      "createdAt": "2026-02-05T12:00:00.000Z",
      "updatedAt": "2026-02-05T12:00:00.000Z"
    }
  }
}
```

---

### memory.link

Create a relationship between two entities in the AGE graph.

**Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceId` | UUID | Yes | Source entity ID |
| `targetId` | UUID | Yes | Target entity ID |
| `relation` | string | Yes | Relationship type (e.g., `owns`, `knows`, `works_at`) |
| `attributes` | object | No | Properties on the edge |
| `validFrom` | datetime | No | When relationship started |
| `validUntil` | datetime | No | When relationship ended |
| `bidirectional` | boolean | No | Create edge in both directions |

**Example:**
```json
{
  "args": {
    "sourceId": "e4f0be98-c583-4e2d-9c2f-355758ea239d",
    "targetId": "44ca9b38-2074-416d-b2c0-42b1086b17fb",
    "relation": "owns",
    "attributes": {
      "role": "maintainer"
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "relation": "OWNS",
    "sourceId": "e4f0be98-c583-4e2d-9c2f-355758ea239d",
    "targetId": "44ca9b38-2074-416d-b2c0-42b1086b17fb",
    "bidirectional": false,
    "edge": {
      "id": 1688849860263937,
      "label": "OWNS",
      "properties": {"created_at": "2026-02-05T12:00:00.000Z"}
    }
  }
}
```

**Common Relation Types:**
- `OWNS` - ownership/authorship
- `KNOWS` - person-to-person
- `WORKS_AT` - employment
- `PART_OF` - membership/containment
- `DEPENDS_ON` - dependencies
- `RELATED_TO` - general association

---

### memory.unlink

Remove a relationship between two entities in the AGE graph.

**Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceId` | UUID | Yes | Source entity ID |
| `targetId` | UUID | Yes | Target entity ID |
| `relation` | string | No | Relation type to delete (if omitted, deletes ALL edges) |

**Example - Delete specific relation:**
```json
{
  "args": {
    "sourceId": "e4f0be98-c583-4e2d-9c2f-355758ea239d",
    "targetId": "44ca9b38-2074-416d-b2c0-42b1086b17fb",
    "relation": "owns"
  }
}
```

**Example - Delete all relations between entities:**
```json
{
  "args": {
    "sourceId": "e4f0be98-c583-4e2d-9c2f-355758ea239d",
    "targetId": "44ca9b38-2074-416d-b2c0-42b1086b17fb"
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "sourceId": "e4f0be98-...",
    "targetId": "44ca9b38-...",
    "relation": "owns",
    "deleted": 1
  }
}
```

---

### memory.evidence

Attach evidence/provenance to entities or episodes.

**Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Evidence type (e.g., `url`, `document`, `note`) |
| `reference` | string | Yes | Source reference (URL, file path, etc.) |
| `snippet` | string | No | Optional snippet or excerpt |
| `taint` | string[] | No | Taint labels for this evidence |
| `entityIds` | UUID[] | No | Entities linked to this evidence |
| `episodeIds` | UUID[] | No | Episodes linked to this evidence |
| `relevance` | number | No | 0.0-1.0 relevance score (default 1.0) |

**Example:**
```json
{
  "args": {
    "type": "url",
    "reference": "https://example.com/post/123",
    "snippet": "Launch updated for Q2.",
    "taint": ["external"],
    "entityIds": ["550e8400-e29b-41d4-a716-446655440000"],
    "episodeIds": ["550e8400-e29b-41d4-a716-446655440001"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "evidence": {
      "id": "550e8400-e29b-41d4-a716-446655440009",
      "type": "url",
      "reference": "https://example.com/post/123",
      "snippet": "Launch updated for Q2."
    },
    "linkedEntities": 1,
    "linkedEpisodes": 1
  }
}
```

---

### memory.query

Query entities and relationships. Supports multiple query modes.

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `entityId` | UUID | Lookup entity by ID |
| `entityName` | string | Lookup entity by exact name |
| `searchText` | string | Full-text search on name and description |
| `entityType` | enum | Filter by entity type |
| `attributeQuery` | object | Search by attributes (JSONB containment) |
| `fromEntity` | UUID | Start neighborhood traversal from this entity |
| `maxHops` | number | Max graph hops (1-5, default 2) |
| `relationTypes` | string[] | Filter by relation types |
| `cypher` | string | Raw Cypher query |
| `episodeType` | string | Query episodes by type |
| `minImportance` | number | Filter episodes by importance |
| `since` | datetime | Filter episodes by date |
| `evidenceForEntity` | UUID | Fetch evidence linked to an entity |
| `evidenceForEpisode` | UUID | Fetch evidence linked to an episode |
| `limit` | number | Max results (1-100, default 50) |

**Example - Full-Text Search (NEW):**
```json
{"args": {"searchText": "gate"}}
```
Returns entities where name or description contains words starting with "gate" (e.g., "Gatekeeper").

**Example - Entity Lookup:**
```json
{"args": {"entityName": "Evan"}}
```

**Example - Neighborhood Traversal:**
```json
{
  "args": {
    "fromEntity": "e4f0be98-c583-4e2d-9c2f-355758ea239d",
    "maxHops": 2,
    "relationTypes": ["OWNS", "WORKS_AT"]
  }
}
```

**Example - Raw Cypher:**
```json
{
  "args": {
    "cypher": "MATCH (a)-[r]->(b) RETURN {source: a.id, relation: type(r), target: b.id}"
  }
}
```

> **Note:** Cypher queries must return a single column. Use maps to aggregate multiple values.

**Example - Attribute Search:**
```json
{
  "args": {
    "attributeQuery": {"language": "TypeScript"}
  }
}
```

**Example - Episode Query:**
```json
{
  "args": {
    "episodeType": "decision",
    "minImportance": 0.7,
    "since": "2026-02-01T00:00:00Z",
    "limit": 10
  }
}
```

**Example - Evidence Query:**
```json
{
  "args": {
    "evidenceForEntity": "550e8400-e29b-41d4-a716-446655440000",
    "limit": 5
  }
}
```

---

### memory.episode

Log an event, decision, or observation.

**Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | enum | Yes | `decision`, `event`, `observation`, `interaction`, `milestone` |
| `summary` | string | Yes | Brief description (max 1000 chars) |
| `details` | object | No | Structured details |
| `importance` | number | No | 0.0-1.0, default 0.5 |
| `occurredAt` | datetime | No | When it happened (default: now) |
| `provenance` | string | No | Source (max 255 chars) |
| `entityIds` | UUID[] | No | Link to entities |
| `entityRoles` | object | No | Map of entityId -> role |

**Example:**
```json
{
  "args": {
    "type": "decision",
    "summary": "Chose SQL+Graph hybrid architecture for memory system",
    "details": {
      "alternatives_considered": ["Pure SQL", "Pure Graph", "Document DB"],
      "rationale": "Eliminates dual-write consistency issues"
    },
    "importance": 0.9,
    "entityIds": ["44ca9b38-2074-416d-b2c0-42b1086b17fb"],
    "entityRoles": {
      "44ca9b38-2074-416d-b2c0-42b1086b17fb": "subject"
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "episode": {
      "id": "69001259-785f-4ce5-a16f-0d1fa289c55f",
      "type": "decision",
      "summary": "Chose SQL+Graph hybrid architecture...",
      "importance": 0.9,
      "occurredAt": "2026-02-05T12:00:00.000Z"
    },
    "linkedEntities": 1
  }
}
```

---

## Data Model

### Entity Types

| Type | Description | Example |
|------|-------------|---------|
| `person` | Individual humans | Team members, contacts |
| `organization` | Companies, teams, groups | Anthropic, Engineering Team |
| `project` | Software projects, initiatives | Gatekeeper, Memory System |
| `concept` | Abstract ideas, technologies | TypeScript, Graph Databases |
| `place` | Physical or virtual locations | San Francisco, GitHub |
| `event` | Scheduled occurrences | Meetings, releases |
| `document` | Files, articles, specs | README, RFC |

### Episode Types

| Type | Use Case |
|------|----------|
| `decision` | Architectural choices, tradeoffs |
| `event` | Things that happened |
| `observation` | Insights, learnings |
| `interaction` | Conversations, meetings |
| `milestone` | Significant achievements |

---

## Docker Setup

For production deployment, use Docker Compose:

```yaml
# docker-compose.yaml
version: '3.8'

services:
  postgres-age:
    image: apache/age:release_PG16_1.6.0
    container_name: runestone-memory
    environment:
      POSTGRES_USER: runestone
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-runestone_dev}
      POSTGRES_DB: memory
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-age.sql:/docker-entrypoint-initdb.d/01-init-age.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U runestone -d memory"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

```sql
-- init-age.sql
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = public, ag_catalog, "$user";
SELECT create_graph('memory_graph');
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |

Example:
```bash
DATABASE_URL="postgresql://runestone:password@127.0.0.1:5433/memory"
```

---

## Use Cases

### Building Agent Memory

```bash
# Agent learns about a new person
memory.upsert: {type: "person", name: "Bob", description: "Product manager"}

# Agent learns Bob works at Acme
memory.upsert: {type: "organization", name: "Acme Corp"}
memory.link: {sourceId: "<bob-id>", targetId: "<acme-id>", relation: "works_at"}

# Later, agent queries Bob's context
memory.query: {fromEntity: "<bob-id>", maxHops: 2}
```

### Knowledge Graph

```bash
# Build a technology knowledge graph
memory.upsert: {type: "concept", name: "TypeScript"}
memory.upsert: {type: "concept", name: "JavaScript"}
memory.link: {sourceId: "<ts-id>", targetId: "<js-id>", relation: "compiles_to"}
```

### Decision Logging

```bash
# Log important decisions for future reference
memory.episode: {
  type: "decision",
  summary: "Migrated from REST to GraphQL",
  importance: 0.9,
  details: {reason: "Better type safety", alternatives: ["gRPC"]}
}

# Query recent decisions
memory.query: {episodeType: "decision", minImportance: 0.7, limit: 10}
```

---

## Troubleshooting

### "Database not available"

Memory tools require `DATABASE_URL` to be set. Without it, memory tools return this error.

### "function cypher(unknown, unknown) does not exist"

AGE extension not properly loaded. Ensure:
1. `LOAD 'age'` runs on connection
2. `search_path` includes `ag_catalog`

The gatekeeper handles this automatically via connection pool initialization.

### Entities not appearing in queries

Check that you're querying the right table. Entities are in SQL (`public.entities`), relationships are in AGE graph.

```bash
# Check SQL entities
docker exec runestone-memory psql -U runestone -d memory \
  -c "SELECT * FROM public.entities;"

# Check AGE relationships
docker exec runestone-memory psql -U runestone -d memory -c "
  LOAD 'age';
  SET search_path = public, ag_catalog;
  SELECT * FROM cypher('memory_graph', \$\$MATCH (a)-[r]->(b) RETURN a, r, b\$\$) AS (a agtype, r agtype, b agtype);
"
```
