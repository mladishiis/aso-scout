# ASO Scout

ASO Scout is a small CLI for early app name research.

It helps you quickly screen candidate app names against:

- Apple App Store via the public iTunes Search API
- Google Play search result pages
- common domains with DNS and RDAP checks
- fuzzy name similarity
- app category conflicts
- ASO keyword profiles
- CSV, Markdown, and JSON reports
- local caching for repeated research

It is not a trademark search and it cannot prove that a name is legally available. Use it as a fast first pass before deeper ASO and legal checks.

## Install

```bash
git clone https://github.com/mladishiis/aso-scout.git
cd aso-scout
npm install
```

No runtime dependencies are required.

## Usage

Check a few names directly:

```bash
node bin/aso-scout.js Bitescale Mealva Gramva
```

Check names from a file:

```bash
node bin/aso-scout.js --names examples/names.txt
```

Output JSON:

```bash
node bin/aso-scout.js --names examples/names.txt --json
```

Change country or domain suffixes:

```bash
node bin/aso-scout.js --country us --domains com,app,io,co Bitescale
```

Use a keyword profile:

```bash
node bin/aso-scout.js --profile calories Bitescale Mealva
node bin/aso-scout.js --profile language LexiPop Wordzy
```

Generate candidate names:

```bash
node bin/aso-scout.js generate --profile calories --count 100
```

Write reports:

```bash
node bin/aso-scout.js --names examples/names.txt --csv report.csv --markdown report.md
```

Cache network results:

```bash
node bin/aso-scout.js --names examples/names.txt --cache .aso-cache.json --cache-ttl 24h
```

Speed up larger lists with parallel checks:

```bash
node bin/aso-scout.js --names examples/names.txt --concurrency 10
```

Lower concurrency if a source starts timing out or rate limiting:

```bash
node bin/aso-scout.js --names examples/names.txt --concurrency 2
```

Skip slow checks:

```bash
node bin/aso-scout.js --no-google-play --no-domains Bitescale
```

## Scoring

The score is intentionally simple:

- exact App Store match lowers the score strongly
- fuzzy App Store close matches lower the score
- close matches in the same App Store category lower the score
- Google Play title-like hits lower the score
- registered or DNS-active domains lower the score
- useful ASO tokens from the selected profile raise the score

The result is a triage signal, not a final answer.

## Example

```text
Name       Score  Risk    App Store                    Google Play  Domains
Bitescale  78     low     exact 0, close 0, category 0  titles 0     .com registered, .app available-ish
Portio     0      high    exact 2, close 3, category 2  titles 3     .com registered, .app registered
```

## Notes

- App Store data comes from `https://itunes.apple.com/search`.
- Google Play does not provide a public ASO search API; this tool uses a lightweight web search page check.
- Domain checks use DNS plus RDAP. A domain result can still need manual registrar verification.
- The default concurrency is conservative. Increase it for quick brainstorming, lower it for RDAP-heavy domain checks.
- Always verify final names manually in stores, domains, social handles, and trademark databases.
