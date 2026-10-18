# =============================================================================
# Any Schema - Salesforce schema export (Windows PowerShell 5.1 / PowerShell 7)
#
# Requirements: Salesforce CLI (sf) logged in to your org:
#   sf org login web --alias my-org
#
# Usage:
#   .\salesforce-export.ps1 -Org my-org
#   .\salesforce-export.ps1 -Org my-org -Objects Account,Contact,Invoice__c
#   .\salesforce-export.ps1 -Org my-org -Out crm.json
# (If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\salesforce-export.ps1 -Org my-org)
# =============================================================================
param(
  [Parameter(Mandatory = $true)][string]$Org,
  [string[]]$Objects,
  [string]$Out = "salesforce-schema.json"
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command sf -ErrorAction SilentlyContinue)) {
  throw "Salesforce CLI (sf) not found: https://developer.salesforce.com/tools/salesforcecli"
}

if (-not $Objects) {
  $custom = (sf sobject list --sobject custom --target-org $Org --json | Out-String | ConvertFrom-Json).result
  $Objects = @("Account", "Contact", "Lead", "Opportunity", "OpportunityLineItem", "Product2", "Case", "Campaign", "User") + @($custom)
}

$keep = "name","label","type","length","precision","scale","nillable","unique","externalId","idLookup","nameField",
        "autoNumber","calculated","calculatedFormula","defaultValue","defaultValueFormula","inlineHelpText",
        "referenceTo","relationshipName","relationshipOrder","cascadeDelete","restrictedDelete","custom"

$result = New-Object System.Collections.ArrayList
$i = 0
foreach ($obj in $Objects) {
  $i++
  Write-Host "[$i/$($Objects.Count)] describing $obj"
  try {
    $d = (sf sobject describe --sobject $obj --target-org $Org --json | Out-String | ConvertFrom-Json).result
  } catch {
    Write-Host "  skipped $obj (not found or no access)"
    continue
  }
  if (-not $d) { Write-Host "  skipped $obj"; continue }
  $fields = foreach ($f in $d.fields) {
    $o = [ordered]@{}
    foreach ($k in $keep) { $o[$k] = $f.$k }
    $o["picklistValues"] = @($f.picklistValues | ForEach-Object { [ordered]@{ value = $_.value; active = $_.active } })
    $o
  }
  [void]$result.Add([ordered]@{
    name = $d.name; label = $d.label; labelPlural = $d.labelPlural; custom = $d.custom
    keyPrefix = $d.keyPrefix; queryable = $d.queryable; fields = @($fields)
  })
}

ConvertTo-Json -InputObject @($result) -Depth 20 | Set-Content -Path $Out -Encoding UTF8
Write-Host "Wrote $Out - drop it into Any Schema."
