# MusiGod API Test Runner
# Usage: .\scripts\test-api.ps1 -Endpoint submit-statement

param([string]$Endpoint = "submit-statement")

$base = "https://musigod.com/api"

$payloads = @{
    "submit-statement" = '{"artist_id":"3d4788b6-2a86-4ed5-8f27-ab95b3a230d3","source_code":"ASCAP","statement_period_start":"2024-01-01","statement_period_end":"2024-03-31","file_type":"MANUAL","notes":"Q1 2024 test ingestion","line_items":[{"song_title":"Test Track 001","isrc":"USRC12400001","royalty_type":"PERFORMANCE","gross_amount_usd":250,"is_recovery":true},{"song_title":"Test Track 002","isrc":"USRC12400002","royalty_type":"PERFORMANCE","gross_amount_usd":180,"is_recovery":false}]}'
}

if (-not $payloads.ContainsKey($Endpoint)) {
    Write-Host "Unknown endpoint: $Endpoint" -ForegroundColor Red
    Write-Host "Available: $($payloads.Keys -join ', ')" -ForegroundColor Yellow
    exit 1
}

$url = "$base/$Endpoint"
$body = $payloads[$Endpoint]

Write-Host "POST $url" -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri $url -Method POST -ContentType "application/json" -Body $body
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host $reader.ReadToEnd() -ForegroundColor Red
    }
}
