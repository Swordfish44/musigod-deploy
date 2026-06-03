# MusiGod API Test Runner
# Usage: .\scripts\test-api.ps1 -Endpoint submit-statement

param([string]$Endpoint = "submit-statement")

$base = "https://musigod.com/api"

$fixtureMap = @{
    "submit-statement" = "scripts\test-submit-statement.json"
}

if (-not $fixtureMap.ContainsKey($Endpoint)) {
    Write-Host "Unknown endpoint: $Endpoint" -ForegroundColor Red
    Write-Host "Available: $($fixtureMap.Keys -join ', ')" -ForegroundColor Yellow
    exit 1
}

$fixturePath = $fixtureMap[$Endpoint]
if (-not (Test-Path $fixturePath)) {
    Write-Host "Fixture not found: $fixturePath" -ForegroundColor Red
    exit 1
}

$url = "$base/$Endpoint"
$body = Get-Content $fixturePath -Raw -Encoding UTF8

Write-Host "POST $url" -ForegroundColor Cyan
Write-Host "Payload: $body" -ForegroundColor Gray

try {
    $response = Invoke-RestMethod -Uri $url -Method POST -ContentType "application/json; charset=utf-8" -Body $body
    $response | ConvertTo-Json -Depth 5
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    Write-Host "ERROR $statusCode" -ForegroundColor Red
    try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $errorBody = $reader.ReadToEnd()
        Write-Host "Response body: $errorBody" -ForegroundColor Yellow
    } catch {
        Write-Host "Could not read response body" -ForegroundColor Red
    }
}
