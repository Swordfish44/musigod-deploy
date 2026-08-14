# MusiGod — Next Esham Diagnostic Stage

The read-only Esham catalog verification completed successfully.

## Verified production state

- Tracks: 196
- With writers: 188
- Without writers: 8
- Incident tracks: 31/31 healthy and `EXACT_MATCH`
- Graph links: 31
- Readiness rows: 980
- `BLOCKED`: 980
- HTTP failures: 0

## Instructions

Proceed with the next diagnostic stage only.

1. Identify the exact eight tracks with no writer data, including track ID, title, release, ISRC, and MBID where available.
2. Determine whether each track has recoverable writer data in existing enrichment results before making any external request.
3. Prepare a fresh Genius-enrichment dry run scoped only to those eight tracks.
4. Do not write to production, apply migrations, alter readiness decisions, overwrite existing writers, or expose credentials.
5. Report which tracks can be resolved automatically, which require manual research, and the exact proposed changes.
6. Explain why only 31 graph links exist for 196 tracks and quantify the graph-sync gap without modifying it.
7. Run the complete test suite after making any code-only changes.

Stop before all database writes and show me the dry-run results.
