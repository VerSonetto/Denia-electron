# The same quality gate runs locally and in CI. It never installs or starts the app.
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$TaskRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $TaskRoot
try {
    Push-Location electron
    try {
        npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Electron typecheck failed' }
        npm test
        if ($LASTEXITCODE -ne 0) { throw 'Electron tests failed' }
    } finally { Pop-Location }

    Push-Location web
    try {
        if ($SkipBuild) {
            pnpm check
            if ($LASTEXITCODE -ne 0) { throw 'Frontend checks failed' }
            pnpm typecheck
        } else { pnpm build }
        if ($LASTEXITCODE -ne 0) { throw 'Frontend typecheck or build failed' }
    } finally { Pop-Location }
} finally { Pop-Location }