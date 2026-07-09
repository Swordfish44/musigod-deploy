# MusicBrainz Ingestion Plan

## Overview

MusicBrainz is the canonical open-music encyclopedia. For MusiGod's Rights Graph, it
functions as **Layer 0 metadata** — the authoritative source of stable identifiers
(MBIDs), recording-to-work relationships, and entity disambiguation that every
downstream enrichment layer is anchored to.

---

## Why MusicBrainz Is Layer 0

| Property | Detail |
|---|---|
| Stable identifiers | MBIDs are UUIDs that persist across edits and are globally unique |
| Work-level credits | recording → work → artist-credit chain links recordings to compositions |
| Open license | CC0 (public domain) for data dumps; no royalty or attribution requirement |
| Community-verified | Millions of editor contributions with merge/split audit trail |
| API + dumps | Live API for enrichment; full dumps for bulk import |

MusiGod's enrichment pipeline already consumes MusicBrainz via the live API
(`lib/enrich-catalog.js`). The local staging environment adds bulk-import capability
for evidence-lake analysis, graph pre-computation, and offline development.

---

## Why It Must Not Be Imported Directly Into Production

1. **Size** — A full MusicBrainz dump is ~25 GB compressed, ~150 GB uncompressed.
   Importing raw into production Supabase would exhaust row limits and incur
   significant egress/storage costs.

2. **Schema mismatch** — MusicBrainz uses ~100 normalized tables. MusiGod's Rights
   Graph uses a purpose-built provenance-first schema. A direct import would pollute
   the graph with unresolved entities and broken foreign keys.

3. **Licensing** — Although the data is CC0, attribution-chain records must be
   preserved per MusiGod's evidence-provenance requirements. A raw import loses that.

4. **Bad matches** — MusicBrainz recordings frequently share names across artists.
   Disambiguation must be applied before any MBID is trusted in the Rights Graph.

5. **Irreversibility** — Production Supabase has live user data. An untested bulk
   import could corrupt existing enriched records or trigger RLS/trigger side-effects.

---

## Proposed Ingestion Flow

```
MusicBrainz dump (.tar.bz2)
  ↓  [download to data/musicbrainz/dumps/]
Local Postgres staging (port 55432, Docker)
  ↓  [restore + index]
Transform scripts (data/musicbrainz/scripts/)
  ↓  [MBID mapping, entity resolution, dedup, provenance tagging]
MusiGod Rights Graph (catalog_enriched_tracks_v1, future graph tables)
  ↓  [only verified, scoped records cross the production boundary]
```

Each stage is independently reviewable. Nothing crosses to production until
explicitly authorized per the merge policy in `lib/writer-merge-policy.js`.

---

## Required Source Provenance

Every record ingested from MusicBrainz into the Rights Graph must carry:

- `source: 'musicbrainz'`
- `recording_mbid` — the stable MBID for the recording
- `release_mbid` — the release the recording was found on
- `work_mbid` (when available) — the linked composition
- `artist_mbid` — the performing/credited artist
- `fetched_at` — ISO-8601 timestamp of when the data was retrieved or dump was dated

---

## MBID Preservation Strategy

MBIDs are the join key between MusicBrainz and all downstream systems:

- **Never discard an MBID** once stored. If an entity is later merged/split in MB,
  keep the original MBID and record the redirect alongside it.
- `catalog_enriched_tracks_v1.recording_mbid` is the canonical anchor — all
  enrichment sources (Discogs, Genius, manual) are secondary evidence on top of it.
- The `dedup_key` generated column uses `recording_mbid` as part of its composite
  key, so MBID stability is essential to idempotent persistence.
- Future schema: add a `mb_redirects_v1` table mapping deprecated MBIDs to their
  canonical successors.

---

## Future Daily Replication Strategy

MusicBrainz publishes incremental JSON change feeds. Once the initial bulk import is
validated:

1. Stand up a scheduled job (Render cron or Supabase pg_cron) that polls the
   MusicBrainz change feed for new/edited works and recordings.
2. Apply changes to local staging first; validate with transform scripts.
3. Promote to production only for entities already referenced by MusiGod artists.
4. Rate limit to MusicBrainz API guidelines (1 req/sec, proper User-Agent).

---

## Risks

### Dataset Size
The full dump is ~25 GB compressed / ~150 GB extracted. The local staging volume
must be provisioned accordingly. The Docker volume is stored under
`data/musicbrainz/postgres-data/` (gitignored). Production Supabase is never used
for raw MB data.

### Licensing
MusicBrainz data is CC0. However, MusiGod must preserve the provenance chain
(`source: 'musicbrainz'`) when re-publishing or displaying this data in user-facing
outputs to satisfy downstream publisher and PRO requirements.

### Schema Differences
MusicBrainz uses a fully normalized relational schema (~100 tables) with MB-specific
types and enums. MusiGod's schema is denormalized for query speed and provenance
tracking. Transform scripts must bridge these intentionally; no automatic mapping
should be trusted without QA.

### Duplicate Entities
The same real-world artist, work, or recording may appear under multiple MBIDs (due
to merge lag, data entry errors, or deliberate splits). Identity resolution must be
applied before any MBID is used as a foreign key in production.

### Bad Matches
Artist and track name matching is inherently ambiguous. "Esham - Redrum" may match
multiple recordings. All matches must include a confidence score and human-reviewable
evidence. The `writer-merge-policy.js` conflict mechanism handles contradictions at
the track level; a similar mechanism is needed at the entity-resolution level.
