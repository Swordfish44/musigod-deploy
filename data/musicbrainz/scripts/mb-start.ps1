# mb-start.ps1 — Start the local MusicBrainz staging Postgres container.
# Run from repo root: .\data\musicbrainz\scripts\mb-start.ps1

$ComposeFile = "$PSScriptRoot\..\docker-compose.musicbrainz.yml"

Write-Host "Starting MusicBrainz local staging database..." -ForegroundColor Cyan
docker compose -f $ComposeFile up -d

if ($LASTEXITCODE -ne 0) {
    Write-Error "docker compose up failed. Is Docker Desktop running?"
    exit 1
}

Write-Host ""
Write-Host "Waiting for Postgres to be ready..." -ForegroundColor Yellow
$retries = 12
for ($i = 1; $i -le $retries; $i++) {
    $ready = docker exec musigod_mb_staging pg_isready -U musicbrainz -d musicbrainz_staging 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Ready." -ForegroundColor Green
        break
    }
    if ($i -eq $retries) {
        Write-Warning "Postgres did not become ready after $retries attempts."
    } else {
        Write-Host "  attempt $i/$retries — not ready yet, waiting 5s..."
        Start-Sleep -Seconds 5
    }
}

Write-Host ""
Write-Host "Connection details:" -ForegroundColor Cyan
Write-Host "  Host:     localhost"
Write-Host "  Port:     55432"
Write-Host "  Database: musicbrainz_staging"
Write-Host "  User:     musicbrainz"
Write-Host "  Password: local_musicbrainz_only"
Write-Host ""
Write-Host "Connect:  .\data\musicbrainz\scripts\mb-connect.ps1"
Write-Host "Status:   .\data\musicbrainz\scripts\mb-status.ps1"
Write-Host "Stop:     .\data\musicbrainz\scripts\mb-stop.ps1"
