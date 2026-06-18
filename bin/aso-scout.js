#!/usr/bin/env node

import dns from "node:dns/promises";
import fs from "node:fs/promises";

const DEFAULT_COUNTRY = "us";
const DEFAULT_DOMAINS = ["com", "app", "io"];
const DEFAULT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 12000;
const ASO_TOKENS = [
  "calorie",
  "calories",
  "food",
  "meal",
  "macro",
  "macros",
  "weight",
  "weigh",
  "scale",
  "bite",
  "portion",
  "diet",
  "fit",
  "body",
  "protein",
  "kcal"
];

function usage() {
  console.log(`ASO Scout

Usage:
  aso-scout [options] <name...>
  aso-scout --names names.txt [options]

Options:
  --names <file>          Read candidate names from a newline-separated file
  --country <code>        App Store / Google Play country code. Default: ${DEFAULT_COUNTRY}
  --domains <list>        Comma-separated TLDs to check. Default: ${DEFAULT_DOMAINS.join(",")}
  --limit <number>        App Store result limit. Default: ${DEFAULT_LIMIT}
  --json                  Print JSON instead of a table
  --no-app-store          Skip App Store checks
  --no-google-play        Skip Google Play checks
  --no-domains            Skip domain DNS checks
  --help                  Show this help

Examples:
  aso-scout Bitescale Mealva Gramva
  aso-scout --names examples/names.txt --country us
  aso-scout --domains com,app,io,co --json Bitescale
`);
}

function parseArgs(argv) {
  const args = {
    country: DEFAULT_COUNTRY,
    domains: DEFAULT_DOMAINS,
    limit: DEFAULT_LIMIT,
    appStore: true,
    googlePlay: true,
    domainsEnabled: true,
    json: false,
    names: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--names") args.namesFile = next();
    else if (arg === "--country") args.country = next().toLowerCase();
    else if (arg === "--domains") args.domains = splitList(next()).map(cleanTld);
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-app-store") args.appStore = false;
    else if (arg === "--no-google-play") args.googlePlay = false;
    else if (arg === "--no-domains") args.domainsEnabled = false;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else args.names.push(arg);
  }

  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) {
    throw new Error("--limit must be an integer from 1 to 200");
  }

  args.domains = args.domains.filter(Boolean);
  return args;
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function cleanTld(value) {
  return value.replace(/^\./, "").toLowerCase();
}

function normalizeName(value) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeCompare(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugForDomain(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

async function readNames(args) {
  const names = [...args.names];
  if (args.namesFile) {
    const text = await fs.readFile(args.namesFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const clean = line.replace(/#.*/, "").trim();
      if (clean) names.push(clean);
    }
  }

  return Array.from(new Set(names.map(normalizeName).filter(Boolean)));
}

async function fetchText(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "aso-scout/0.1 (+https://github.com/mladishiis/aso-scout)"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return fetchText(url, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function checkAppStore(name, { country, limit }) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", name);
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", country);
  url.searchParams.set("limit", String(limit));

  try {
    const json = await fetchJson(url);
    const nameKey = normalizeCompare(name);
    const results = (json.results || []).map((item) => ({
      trackName: item.trackName,
      artistName: item.artistName,
      primaryGenreName: item.primaryGenreName,
      trackViewUrl: item.trackViewUrl,
      bundleId: item.bundleId
    }));

    const exact = results.filter((item) => normalizeCompare(item.trackName) === nameKey);
    const close = results.filter((item) => {
      const trackKey = normalizeCompare(item.trackName);
      return trackKey !== nameKey && (trackKey.includes(nameKey) || nameKey.includes(trackKey));
    });

    return {
      ok: true,
      url: url.toString(),
      count: results.length,
      exact,
      close: close.slice(0, 5),
      top: results.slice(0, 5)
    };
  } catch (error) {
    return { ok: false, url: url.toString(), error: error.message, count: 0, exact: [], close: [], top: [] };
  }
}

async function checkGooglePlay(name, { country }) {
  const url = new URL("https://play.google.com/store/search");
  url.searchParams.set("q", `"${name}"`);
  url.searchParams.set("c", "apps");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", country.toUpperCase());

  try {
    const html = await fetchText(url);
    const nameKey = normalizeCompare(name);
    const normalizedHtml = normalizeCompare(html);
    const exactMentions = countOccurrences(normalizedHtml, nameKey);
    const titleLike = extractGooglePlayTitleCandidates(html, name).slice(0, 5);

    return {
      ok: true,
      url: url.toString(),
      exactMentions,
      titleLike
    };
  } catch (error) {
    return { ok: false, url: url.toString(), error: error.message, exactMentions: 0, titleLike: [] };
  }
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function extractGooglePlayTitleCandidates(html, name) {
  const candidates = new Set();
  const nameKey = normalizeCompare(name);
  const patterns = [
    /"name"\s*:\s*"([^"]{1,80})"/g,
    /aria-label="([^"]{1,80})"/g,
    /<span[^>]*>([^<]{1,80})<\/span>/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const value = decodeHtml(match[1]).replace(/\s+/g, " ").trim();
      if (!value || value.length < 3 || /^[•·\-\s]+$/.test(value)) continue;
      const valueKey = normalizeCompare(value);
      if (valueKey.includes(nameKey) || nameKey.includes(valueKey)) candidates.add(value);
    }
  }

  return Array.from(candidates);
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function checkDomains(name, tlds) {
  const slug = slugForDomain(name);
  if (!slug) return [];

  return Promise.all(tlds.map(async (tld) => {
    const domain = `${slug}.${tld}`;
    try {
      await dns.lookup(domain);
      return { domain, status: "occupied" };
    } catch (error) {
      if (["ENOTFOUND", "ENODATA"].includes(error.code)) {
        return { domain, status: "no-dns", note: "No DNS record found; still verify registrar availability." };
      }
      if (["SERVFAIL", "ETIMEOUT", "EAI_AGAIN"].includes(error.code)) {
        return { domain, status: "unknown", error: error.code };
      }
      return { domain, status: "unknown", error: error.code || error.message };
    }
  }));
}

function scoreName(name, checks) {
  let score = 70;
  const reasons = [];
  const tokens = keywordSignals(name);

  if (checks.appStore?.ok) {
    if (checks.appStore.exact.length > 0) {
      score -= 45;
      reasons.push(`App Store exact match: ${checks.appStore.exact[0].trackName}`);
    }
    if (checks.appStore.close.length > 0) {
      score -= Math.min(20, checks.appStore.close.length * 6);
      reasons.push(`App Store close matches: ${checks.appStore.close.map((item) => item.trackName).join(", ")}`);
    }
  } else if (checks.appStore) {
    score -= 5;
    reasons.push(`App Store check failed: ${checks.appStore.error}`);
  }

  if (checks.googlePlay?.ok) {
    if (checks.googlePlay.titleLike.length > 0) {
      score -= Math.min(18, checks.googlePlay.titleLike.length * 6);
      reasons.push(`Google Play title-like hits: ${checks.googlePlay.titleLike.join(", ")}`);
    } else if (checks.googlePlay.exactMentions > 20) {
      score -= 8;
      reasons.push(`Google Play page mentions: ${checks.googlePlay.exactMentions}`);
    }
  } else if (checks.googlePlay) {
    score -= 3;
    reasons.push(`Google Play check failed: ${checks.googlePlay.error}`);
  }

  const occupiedDomains = (checks.domains || []).filter((item) => item.status === "occupied");
  if (occupiedDomains.length > 0) {
    score -= Math.min(18, occupiedDomains.length * 6);
    reasons.push(`Occupied domains: ${occupiedDomains.map((item) => item.domain).join(", ")}`);
  }

  if (tokens.length > 0) {
    score += Math.min(12, tokens.length * 4);
    reasons.push(`ASO signals in name: ${tokens.join(", ")}`);
  }

  const length = [...name.replace(/\s+/g, "")].length;
  if (length < 5) {
    score -= 8;
    reasons.push("Very short name can be harder to own in search.");
  } else if (length <= 10) {
    score += 6;
    reasons.push("Short and easy to remember.");
  } else if (length > 18) {
    score -= 6;
    reasons.push("Long name; check App Store 30 character limit with subtitle strategy.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    risk: score >= 75 ? "low" : score >= 50 ? "medium" : "high",
    reasons
  };
}

function keywordSignals(name) {
  const key = normalizeCompare(name);
  return ASO_TOKENS.filter((token) => key.includes(token));
}

async function inspectName(name, args) {
  const checks = {};

  const tasks = [];
  if (args.appStore) tasks.push(checkAppStore(name, args).then((result) => { checks.appStore = result; }));
  if (args.googlePlay) tasks.push(checkGooglePlay(name, args).then((result) => { checks.googlePlay = result; }));
  if (args.domainsEnabled) tasks.push(checkDomains(name, args.domains).then((result) => { checks.domains = result; }));
  await Promise.all(tasks);

  return {
    name,
    ...scoreName(name, checks),
    checks
  };
}

function printTable(results) {
  const rows = results.map((result) => ({
    name: result.name,
    score: String(result.score),
    risk: result.risk,
    appStore: summarizeAppStore(result.checks.appStore),
    googlePlay: summarizeGooglePlay(result.checks.googlePlay),
    domains: summarizeDomains(result.checks.domains)
  }));

  const columns = [
    ["Name", "name"],
    ["Score", "score"],
    ["Risk", "risk"],
    ["App Store", "appStore"],
    ["Google Play", "googlePlay"],
    ["Domains", "domains"]
  ];

  const widths = columns.map(([label, key]) => {
    return Math.min(44, Math.max(label.length, ...rows.map((row) => row[key].length)));
  });

  console.log(columns.map(([label], index) => pad(label, widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(columns.map(([, key], index) => pad(truncate(row[key], widths[index]), widths[index])).join("  "));
  }

  console.log("\nNotes:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.reasons.slice(0, 3).join(" | ") || "No major signals."}`);
  }
}

function summarizeAppStore(check) {
  if (!check) return "skipped";
  if (!check.ok) return `error: ${check.error}`;
  return `exact ${check.exact.length}, close ${check.close.length}`;
}

function summarizeGooglePlay(check) {
  if (!check) return "skipped";
  if (!check.ok) return `error: ${check.error}`;
  return `mentions ${check.exactMentions}, titles ${check.titleLike.length}`;
}

function summarizeDomains(domains) {
  if (!domains) return "skipped";
  return domains.map((item) => `${item.domain.replace(/^[^.]+\./, ".")} ${item.status}`).join(", ");
}

function pad(value, width) {
  return value + " ".repeat(Math.max(0, width - value.length));
}

function truncate(value, width) {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const names = await readNames(args);
  if (names.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const name of names) {
    results.push(await inspectName(name, args));
  }

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  } else {
    printTable(results);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
