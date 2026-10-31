$ErrorActionPreference = 'Stop'
$playerNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$playerNodePath = if ($playerNodeCommand) { $playerNodeCommand.Source } else {
    Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
}
if (-not (Test-Path -LiteralPath $playerNodePath)) {
    throw 'Node.js is required. Install Node.js 22.12 or newer, then run this script again.'
}
$playerRoot = Join-Path $PSScriptRoot 'adaptive-eq'
if (-not (Test-Path -LiteralPath (Join-Path $playerRoot 'node_modules/vite'))) {
    throw 'Dependencies are missing. Run pnpm install inside adaptive-eq first.'
}
& $playerNodePath (Join-Path $playerRoot 'scripts/dev.mjs') --open
