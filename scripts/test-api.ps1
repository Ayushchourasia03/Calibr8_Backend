# backend/test-api.ps1
$base = "http://localhost:5000"

Write-Host "=== 1. All Rankings ===" -ForegroundColor Green
Invoke-RestMethod "$base/api/rankings" | Format-Table name, college, score, tier

Write-Host "`n=== 2. College Wise - IIT Delhi ===" -ForegroundColor Green
Invoke-RestMethod "$base/api/rankings?scope=college&college=IIT Delhi" | Format-Table name, college, score

Write-Host "`n=== 3. Batch Wise - 2027 ===" -ForegroundColor Green
Invoke-RestMethod "$base/api/rankings?scope=batch&batch=2027" | Format-Table name, batch, score

Write-Host "`n=== 4. State Wise ===" -ForegroundColor Green
Invoke-RestMethod "$base/api/rankings?scope=state&state=Delhi" | Format-Table name, state, score

Write-Host "`n=== 5. Country Wise ===" -ForegroundColor Green
Invoke-RestMethod "$base/api/rankings?scope=country&country=India" | Format-Table name, country, score

Write-Host "`n=== 6. Limit 5 ===" -ForegroundColor Green
Invoke-RestMethod "$base/api/rankings?limit=5" | Format-Table name, score, tier