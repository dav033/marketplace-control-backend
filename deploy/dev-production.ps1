param(
  [string]$HostName = "54.167.34.107",
  [string]$SshUser = "ec2-user",
  [string]$SshKeyPath = "$env:USERPROFILE\.ssh\marketplace-aws",
  [int]$LocalDbPort = 15432,
  [int]$AppPort = 4321
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshTarget = "$SshUser@$HostName"

if (-not (Test-Path -LiteralPath $SshKeyPath -PathType Leaf)) {
  throw "No existe la clave SSH: $SshKeyPath"
}

# Lee DATABASE_URL dentro de una variable del proceso; nunca la muestra ni la guarda.
$readEnvArgs = @(
  "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-i", $SshKeyPath, $sshTarget, "sudo", "-n", "grep", "-E",
  "^DATABASE_URL=", "/etc/marketplace-control/marketplace-control.env"
)
$remoteDatabaseLine = ((& ssh @readEnvArgs 2>$null) -join "").Trim()
if ($LASTEXITCODE -ne 0 -or -not $remoteDatabaseLine.StartsWith("DATABASE_URL=")) {
  throw "No se pudo leer DATABASE_URL protegida desde EC2"
}

$localDatabaseUrl = $remoteDatabaseLine.Substring("DATABASE_URL=".Length)
$localDatabaseUrl = $localDatabaseUrl -replace "127\.0\.0\.1:5432", "127.0.0.1:$LocalDbPort"

$tunnelArgs = @(
  "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=yes", "-i", $SshKeyPath,
  "-L", "127.0.0.1:$LocalDbPort`:127.0.0.1:5432", $sshTarget
)
$tunnel = Start-Process -FilePath "ssh.exe" -ArgumentList $tunnelArgs -WindowStyle Hidden -PassThru

try {
  $ready = $false
  foreach ($attempt in 1..20) {
    if ($tunnel.HasExited) { throw "El túnel SSH terminó antes de abrirse" }
    $probe = Test-NetConnection -ComputerName "127.0.0.1" -Port $LocalDbPort -WarningAction SilentlyContinue
    if ($probe.TcpTestSucceeded) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "No se abrió el túnel PostgreSQL en localhost:$LocalDbPort" }

  $env:DATABASE_URL = $localDatabaseUrl
  Remove-Item Env:ADMIN_ACCESS_KEY -ErrorAction SilentlyContinue
  Push-Location $projectRoot
  try {
    npm run dev -- --host 127.0.0.1 --port $AppPort
  } finally {
    Pop-Location
  }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }
}
