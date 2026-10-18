# Contributing to Any Schema

Thanks for helping. The project is plain JavaScript (ES modules) with no runtime dependencies.

## Setup

```bash
npm install
npm start      # http://localhost:8080
npm test
```

## Where things live

| You want to… | Edit |
|---|---|
| Support a new SQL clause or dialect quirk | `src/core/parsers/sql.js` |
| Support a new input format | add `src/core/parsers/<format>.js`, then wire it into `src/core/parse.js` |
| Improve a column explanation | `byName()` in `src/core/analyze.js` |
| Add a review finding | `buildFindings()` in `src/core/analyze.js` |
| Add a privacy category | `PII_RULES` in `src/core/analyze.js` |
| Add an export query for a database | `export-queries/`, a guide entry in `src/ui/guides.js`, a section in `README.md` with `<!-- query:file -->` markers, then `npm run generate` |
| Change the UI | `src/ui/` |

## Rules of thumb

- **Every change comes with a test or a sample.** Put realistic inputs in `samples/` (they appear as sample buttons too) and assertions in `test/`.
- **Export queries must be read-only** and return structure only, never row data.
- **Explanations should read like a person wrote them.** Short sentences, the column's real names in backticks, no guessing beyond what the name and type support. When unsure, fall back to the generic explanation rather than inventing meaning.
- **Inferred things are labelled as inferred.** Never present a guess as a declared fact.
- Run `npm run generate` after changing `export-queries/` or `samples/`; CI fails if generated files are stale.

## Reporting a parsing problem

Open an issue with the smallest snippet that reproduces it (strip real names if needed), the database and version, and what you expected.
