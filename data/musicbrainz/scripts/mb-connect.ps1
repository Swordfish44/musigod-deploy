# mb-connect.ps1 — Open a psql session inside the staging container.
# Requires psql to be available on PATH, OR uses the containerized psql.
# Run from repo root: .\data\musicbrainz\scripts\mb-connect.ps1

Write-Host "Connecting to MusicBrainz staging database..." -ForegroundColor Cyan
Write-Host "  Container: musigod_mb_staging"
Write-Host "  Database:  musicbrainz_staging"
Write-Host "  User:      musicbrainz"
Write-Host ""

# Use the psql bundled inside the container to avoid requiring a local install.
docker exec -it musigod_mb_staging psql -U musicbrainz -d musicbrainz_staging

# Alternative: connect from host using local psql (if installed)
# $env:PGPASSWORD = 'local_musicbrainz_only'
# psql -h localhost -p 55432 -U musicbrainz -d musicbrainz_staging
