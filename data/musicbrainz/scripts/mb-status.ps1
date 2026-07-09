# mb-status.ps1 — Show the status of the local MusicBrainz staging container.
# Run from repo root: .\data\musicbrainz\scripts\mb-status.ps1

$ComposeFile = "$PSScriptRoot\..\docker-compose.musicbrainz.yml"

Write-Host "=== MusicBrainz Staging — Container Status ===" -ForegroundColor Cyan
docker compose -f $ComposeFile ps

Write-Host ""
Write-Host "=== Postgres Readiness ===" -ForegroundColor Cyan
$ready = docker exec musigod_mb_staging pg_isready -U musicbrainz -d musicbrainz_staging 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "postgres: READY" -ForegroundColor Green
} else {
    Write-Host "postgres: NOT READY (container may be stopped or starting)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Docker Volume ===" -ForegroundColor Cyan
docker volume inspect musigod-deploy_mb_postgres_data 2>&1 | Select-String -Pattern 'Name|Mountpoint|CreatedAt' | ForEach-Object { $_.Line.Trim() }

Write-Host ""
Write-Host "=== Disk Usage (dumps folder) ===" -ForegroundColor Cyan
$dumpsPath = "$PSScriptRoot\..\dumps"
if (Test-Path $dumpsPath) {
    $size = (Get-ChildItem $dumpsPath -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    Write-Host "  $dumpsPath"
    Write-Host "  Total: $([math]::Round($size / 1MB, 1)) MB"
} else {
    Write-Host "  No dumps folder found."
}
