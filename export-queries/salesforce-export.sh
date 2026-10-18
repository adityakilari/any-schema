#!/usr/bin/env bash
# =============================================================================
# Any Schema - Salesforce schema export (macOS / Linux / WSL / Git Bash)
#
# Uses the Salesforce CLI to "describe" objects and writes one JSON file that
# Any Schema reads directly (fields, types, picklists, lookups, master-detail).
#
# Requirements: Salesforce CLI (sf) logged in to your org, and jq.
#   sf org login web --alias my-org
#
# Usage:
#   ./salesforce-export.sh my-org                        # common standard objects + all custom objects
#   ./salesforce-export.sh my-org Account Contact Invoice__c
#   OUT=crm.json ./salesforce-export.sh my-org
# =============================================================================
set -eo pipefail

ORG="$1"
if [ -z "$ORG" ]; then
  echo "usage: $0 <org-alias> [Object ...]" >&2
  exit 1
fi
shift
OUT="${OUT:-salesforce-schema.json}"

command -v sf >/dev/null 2>&1 || { echo "Salesforce CLI (sf) not found: https://developer.salesforce.com/tools/salesforcecli" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found: https://jqlang.github.io/jq/download/" >&2; exit 1; }

OBJECTS=()
if [ "$#" -gt 0 ]; then
  OBJECTS=("$@")
else
  OBJECTS=(Account Contact Lead Opportunity OpportunityLineItem Product2 Case Campaign User)
  while IFS= read -r name; do
    [ -n "$name" ] && OBJECTS+=("$name")
  done < <(sf sobject list --sobject custom --target-org "$ORG" --json | jq -r '.result[]')
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

i=0
for obj in "${OBJECTS[@]}"; do
  i=$((i + 1))
  echo "[$i/${#OBJECTS[@]}] describing $obj" >&2
  if ! sf sobject describe --sobject "$obj" --target-org "$ORG" --json > "$TMP/raw.json" 2>/dev/null; then
    echo "  skipped $obj (not found or no access)" >&2
    continue
  fi
  # keep only what Any Schema uses - smaller file, no record data
  jq '.result | {
        name, label, labelPlural, custom, keyPrefix, queryable,
        fields: [ .fields[] | {
          name, label, type, length, precision, scale, nillable, unique, externalId, idLookup,
          nameField, autoNumber, calculated, calculatedFormula, defaultValue, defaultValueFormula,
          inlineHelpText, referenceTo, relationshipName, relationshipOrder, cascadeDelete,
          restrictedDelete, custom,
          picklistValues: [ .picklistValues[]? | { value, active } ]
        } ]
      }' "$TMP/raw.json" > "$TMP/$(printf '%04d' "$i").json"
done

jq -s '.' "$TMP"/[0-9]*.json > "$OUT"
echo "Wrote $OUT - drop it into Any Schema." >&2
