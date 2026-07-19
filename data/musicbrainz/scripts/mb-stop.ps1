# mb-stop.ps1 — Stop the local MusicBrainz staging Postgres container.
# Data is preserved in the Docker volume. To wipe data, add the -v flag.
# Run from repo root: .\data\musicbrainz\scripts\mb-stop.ps1

param(
    [switch]$WipeData
)

$ComposeFile = "$PSScriptRoot\..\docker-compose.musicbrainz.yml"

if ($WipeData) {
    Write-Warning "WipeData flag set — Docker volume mb_postgres_data will be deleted."
    $confirm = Read-Host "Type YES to confirm volume deletion"
    if ($confirm -ne 'YES') {
        Write-Host "Aborted." -ForegroundColor Yellow
        exit 0
    }
    docker compose -f $ComposeFile down -v
} else {
    Write-Host "Stopping MusicBrainz staging container (data preserved)..." -ForegroundColor Cyan
    docker compose -f $ComposeFile down
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "Stopped." -ForegroundColor Green
} else {
    Write-Error "docker compose down failed."
    exit 1
}
