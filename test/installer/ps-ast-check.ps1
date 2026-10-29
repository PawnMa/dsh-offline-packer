# Parse install-offline.ps1 with the PowerShell AST parser (syntax check only).
# Usage: pwsh -NoProfile -File ps-ast-check.ps1 <path-to-install-offline.ps1>
param([Parameter(Mandatory = $true)][string]$Path)

$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $Path).Path, [ref]$tokens, [ref]$errors) | Out-Null
if ($null -ne $errors -and $errors.Count -gt 0) {
  foreach ($error in $errors) {
    Write-Host ("AST ERROR: line {0}: {1}" -f $error.Extent.StartLineNumber, $error.Message)
  }
  exit 1
}
Write-Host "AST OK: $Path ($($tokens.Count) tokens)"
exit 0
