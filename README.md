# ASO Scout

ASO Scout is a small CLI for early app name research.

It helps you quickly screen candidate app names against:

- Apple App Store via the public iTunes Search API
- Google Play search result pages
- common domains with DNS checks
- simple ASO keyword signals

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

Skip slow checks:

```bash
node bin/aso-scout.js --no-google-play --no-domains Bitescale
```

## Scoring

The score is intentionally simple:

- exact App Store match lowers the score strongly
- close App Store matches lower the score
- Google Play text hits lower the score
- occupied domains lower the score
- useful ASO tokens like `calorie`, `food`, `meal`, `macro`, `weight`, `bite`, `scale`, and `portion` raise the score

The result is a triage signal, not a final answer.

## Example

```text
Name       Score Risk    App Store        Google Play      Domains
Bitescale  78    medium  exact 0 close 0  hits 18          com free, app free, io free
Portio     8     high    exact 2 close 3  hits 42          com occupied
```

## Notes

- App Store data comes from `https://itunes.apple.com/search`.
- Google Play does not provide a public ASO search API; this tool uses a lightweight web search page check.
- Domain checks use DNS resolution. A domain with no DNS record can still be registered, parked, or otherwise unavailable.
- Always verify final names manually in stores, domains, social handles, and trademark databases.
