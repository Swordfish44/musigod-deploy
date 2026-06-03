param([string]$Endpoint = "submit-statement")

$base = "https://musigod.com/api"

$fixtureMap = @{
    "submit-statement" = "scripts\test-submit-statement.json"
}

$fixturePath = $fixtureMap[$Endpoint]
$url = "$base/$Endpoint"
$body = Get-Content $fixturePath -Raw -Encoding UTF8

Write-Host "POST $url" -ForegroundColor Cyan

$headers = @{
    "Content-Type" = "application/json; charset=utf-8"
    "User-Agent"   = "Mozilla/5.0 (MusiGod-Test/1.0)"
    "Accept"       = "application/json"
    "Origin"       = "https://musigod.com"
}

$resp = Invoke-WebRequest -Uri $url -Method POST -Headers $headers -Body $body -ErrorAction SilentlyContinue
Write-Host "Status: $($resp.StatusCode)" -ForegroundColor Cyan
Write-Host "Body: $($resp.Content)" -ForegroundColor Green
