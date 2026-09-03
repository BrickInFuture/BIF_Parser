# Deploy bricklink-refresh worker to Cloud Run (Windows PowerShell).
# From repo root:
#   $env:REFRESH_WORKER_TOKEN = "<long-random-secret>"
#   .\scripts\bricklink-parser\worker\deploy-dev.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Project = if ($env:DEV_PROJECT_ID) { $env:DEV_PROJECT_ID } else { "brickinfuture-306f1" }
$Region = if ($env:REGION) { $env:REGION } else { "europe-west1" }
$Service = if ($env:SERVICE) { $env:SERVICE } else { "bricklink-refresh" }
$Token = $env:REFRESH_WORKER_TOKEN

$GcloudCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
  "C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
  "C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
)
$Gcloud = $GcloudCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Gcloud) {
  $Gcloud = (Get-Command gcloud -ErrorAction SilentlyContinue).Source
}
if (-not $Gcloud) {
  Write-Error "gcloud not found. Install Google Cloud SDK or add it to PATH."
}

if (-not $Token) {
  Write-Error "Set REFRESH_WORKER_TOKEN first (shared secret for API → worker)."
}

Set-Location $Root

Write-Host "Ensuring Artifact Registry repo 'bif'..."
& $Gcloud artifacts repositories describe bif --location=$Region --project=$Project 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  & $Gcloud artifacts repositories create bif `
    --repository-format=docker `
    --location=$Region `
    --project=$Project `
    --quiet
}

Write-Host "Cloud Build + Cloud Run deploy..."
& $Gcloud builds submit `
  --project=$Project `
  --config=scripts/bricklink-parser/worker/cloudbuild.yaml `
  --substitutions="_REGION=$Region,_SERVICE=$Service,_REFRESH_WORKER_TOKEN=$Token" `
  --timeout=1800

$Url = & $Gcloud run services describe $Service --project=$Project --region=$Region --format="value(status.url)"
Write-Host ""
Write-Host "Worker URL: $Url"
Write-Host "Add to functions/.env then redeploy API:"
Write-Host "  PRICE_REFRESH_WORKER_URL=$Url"
Write-Host "  PRICE_REFRESH_WORKER_TOKEN=<same token>"
Write-Host "  npm run deploy:functions:dev"
