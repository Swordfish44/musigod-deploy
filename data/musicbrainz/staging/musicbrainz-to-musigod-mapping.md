# MusicBrainz → MusiGod Rights Graph: Concept Mapping

## Entity Mapping

| MusicBrainz Concept | MusiGod Rights Graph Concept | Notes |
|---|---|---|
| `artist` | `person` / `entity` | MB artists include persons, groups, orchestras, and fictional entities. MusiGod disambiguates on ingest via `artist_type` and `sort_name`. |
| `recording` | `recording` | 1:1 — the MBID is preserved as `recording_mbid` in `catalog_enriched_tracks_v1`. |
| `work` | `composition` | A work is the abstract composition; a recording is a specific performance of it. The recording → work relationship is the key rights chain. |
| `release` | `release` | A release is a specific product (album, single, EP). MusiGod stores `release_mbid` per track for traceability. |
| `release-group` | `release group` | Groups all editions/formats of the same album. Stored as `release_group_mbid`. |
| `label` | `label` / `organization` | Publishing and record label entities. Not yet in MusiGod's production schema — planned for Rights Graph v2. |
| `relationship` | `evidence-backed relationship` | MB relationships (composer, lyricist, performer, publisher) map to MusiGod writer credits with `role` and `source: 'musicbrainz'`. |
| `MBID` | `external_identifier` | Preserved in all `_mbid` columns. Never discarded — see MBID preservation strategy in `docs/musicbrainz-ingestion-plan.md`. |
| `ISRC` | `isrc` | Stored in `catalog_enriched_tracks_v1.isrcs[]` (array). Source of truth for sound recording identity at PROs. |
| `ISWC` | `iswc` | Stored in `catalog_enriched_tracks_v1.iswc`. Composition identifier used by ASCAP, BMI, SESAC. |
| `area` | _(not mapped)_ | MB geographic areas used for artist origin. Not yet consumed by MusiGod. |
| `instrument` | _(not mapped)_ | MB instrument credits are not yet part of MusiGod's Rights Graph. Planned for session musician tracking. |

---

## Relationship Type Mapping (MB → writer credit roles)

| MB Relationship Type | MusiGod Writer Role | Notes |
|---|---|---|
| `composer` | `composer` | Melody/music author |
| `lyricist` | `lyricist` | Lyrics author |
| `writer` | `writer` | Generic credit (covers both when not split) |
| `composer-lyricist` | `composer-lyricist` | Single person credited for both |
| `music` | `composer` | Alternate MB type for music author |
| `lyrics` | `lyricist` | Alternate MB type for lyrics author |
| `words` | `lyricist` | Legacy MB type |
| `written by` | `writer` | Legacy MB type |
| `arranger` | `arranger` | Not a writing credit but tracked for completeness |
| `publisher` | _(publisher entity)_ | Maps to publishing admin relationship, not a writer |

All matched relationships are stored with `source: 'musicbrainz'` and the artist's
`mbid` field populated — enabling MBID-based deduplication in the merge policy.

---

## Key Join Paths (SQL)

```sql
-- recording → work → composer (the core rights chain)
SELECT
  r.id        AS recording_mbid,
  r.name      AS recording_title,
  w.id        AS work_mbid,
  w.name      AS work_title,
  a.id        AS writer_mbid,
  a.name      AS writer_name,
  arel.type   AS writer_role
FROM recording r
JOIN l_recording_work lrw ON lrw.entity0 = r.id
JOIN work w               ON w.id = lrw.entity1
JOIN l_artist_work law    ON law.entity1 = w.id
JOIN link l               ON l.id = law.link
JOIN link_type lt         ON lt.id = l.link_type
JOIN artist a             ON a.id = law.entity0
WHERE lt.name IN ('composer','lyricist','writer','composer-lyricist')
  AND r.id = '<recording-mbid>';
```

---

## Production Boundary Rule

No data from the local staging database (`musicbrainz_staging` on port 55432)
crosses into production Supabase without:

1. Transform script validation (dedup, MBID resolution, confidence score ≥ threshold)
2. Explicit merge policy approval (see `lib/writer-merge-policy.js`)
3. Explicit authorization from the project owner

The Docker Compose file and all staging data are intentionally gitignored (see
`.gitignore` additions) to prevent accidental commits of large dataset files.
