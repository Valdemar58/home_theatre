#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Server = 'production',
    [ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Account = 'admin',
    [string]$ConfigPath,
    [switch]$CopyPassword
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') {
    throw 'Windows DPAPI credentials can only be opened by their original Windows user on the original computer.'
}
if (-not $ConfigPath) {
    $ConfigPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config/home_theater/infrastructure.json'
}
$configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$serverProperty = $configuration.servers.PSObject.Properties[$Server]
if (-not $serverProperty) { throw 'Server is not configured.' }
$ssh = $serverProperty.Value.ssh
if (-not $ssh.PSObject.Properties['accounts']) { throw 'Configure ssh.accounts before selecting an account.' }
$accountProperty = $ssh.accounts.PSObject.Properties[$Account]
if (-not $accountProperty) { throw 'Account is not configured for this server.' }
$selected = $accountProperty.Value
if (-not $selected.credentialFile -or -not [IO.Path]::IsPathRooted($selected.credentialFile)) {
    throw 'An absolute credentialFile path is required.'
}
$credential = Import-Clixml -LiteralPath $selected.credentialFile
if ($credential -isnot [pscredential] -or $credential.UserName -ne $selected.user) {
    throw 'Stored credential does not match the configured account.'
}
if ($CopyPassword) {
    Set-Clipboard -Value $credential.GetNetworkCredential().Password
    Write-Output 'Password copied to the clipboard. It was not printed.'
} else {
    # Return a PSCredential, never a plaintext password or a JSON representation.
    Write-Output $credential
}
