param(
  [string]$HostName = "54.167.34.107",
  [string]$SshUser = "ec2-user",
  [string]$SshKeyPath = "$env:USERPROFILE\.ssh\marketplace-eventos",
  [int]$LocalDbPort = 15432,
  [int]$AppPort = 4321
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sshTarget = "$SshUser@$HostName"

if (-not (Test-Path -LiteralPath $SshKeyPath -PathType Leaf)) {
  throw "No existe la clave SSH: $SshKeyPath"
}

# Lee credenciales dentro de variables del proceso; nunca las muestra ni las guarda.
$readEnvArgs = @(
  "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-i", $SshKeyPath, $sshTarget, "sudo", "-n", "grep", "-E",
  "'^(DATABASE_URL|ADMIN_ACCESS_KEY|OMNISEND_API_KEY|OMNISEND_VERSION)='", "/etc/marketplace-control/marketplace-control.env"
)
$remoteEnvLines = @((& ssh @readEnvArgs 2>$null) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) {
  throw "No se pudieron leer credenciales protegidas desde EC2"
}
$remoteDatabaseLine = $remoteEnvLines | Where-Object { $_.StartsWith("DATABASE_URL=") } | Select-Object -First 1
$remoteAdminLine = $remoteEnvLines | Where-Object { $_.StartsWith("ADMIN_ACCESS_KEY=") } | Select-Object -First 1
$remoteOmnisendKeyLine = $remoteEnvLines | Where-Object { $_.StartsWith("OMNISEND_API_KEY=") } | Select-Object -First 1
$remoteOmnisendVersionLine = $remoteEnvLines | Where-Object { $_.StartsWith("OMNISEND_VERSION=") } | Select-Object -First 1
if (-not $remoteDatabaseLine -or -not $remoteAdminLine) {
  throw "Faltan DATABASE_URL o ADMIN_ACCESS_KEY en EC2"
}

$localDatabaseUrl = $remoteDatabaseLine.Substring("DATABASE_URL=".Length)
$localDatabaseUrl = $localDatabaseUrl -replace "127\.0\.0\.1:5432", "127.0.0.1:$LocalDbPort"
$localAdminAccessKey = $remoteAdminLine.Substring("ADMIN_ACCESS_KEY=".Length)
if ([string]::IsNullOrWhiteSpace($localAdminAccessKey)) {
  throw "ADMIN_ACCESS_KEY vacío en EC2"
}
$localOmnisendApiKey = if ($remoteOmnisendKeyLine) { $remoteOmnisendKeyLine.Substring("OMNISEND_API_KEY=".Length) } else { $null }
$localOmnisendVersion = if ($remoteOmnisendVersionLine) { $remoteOmnisendVersionLine.Substring("OMNISEND_VERSION=".Length) } else { "2026-03-15" }

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
  $env:ADMIN_ACCESS_KEY = $localAdminAccessKey
  if (-not [string]::IsNullOrWhiteSpace($localOmnisendApiKey)) { $env:OMNISEND_API_KEY = $localOmnisendApiKey }
  $env:OMNISEND_VERSION = $localOmnisendVersion
  Push-Location $projectRoot
  try {
    npm run dev -- --host 127.0.0.1 --port $AppPort
    while (-not $tunnel.HasExited) {
      Start-Sleep -Seconds 2
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }
}
