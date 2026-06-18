#!/usr/bin/env node

import dns from "node:dns/promises";
import fs from "node:fs/promises";

const VERSION = "0.2.0";
const DEFAULT_COUNTRY = "us";
const DEFAULT_DOMAINS = ["com", "app", "io"];
const DEFAULT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const PROFILES = {
  calories: {
    tokens: ["calorie", "calories", "food", "meal", "macro", "macros", "weight", "weigh", "scale", "bite", "portion", "diet", "fit", "body", "protein", "kcal"],
    roots: ["bite", "meal", "gram", "scale", "weigh", "portion", "macro", "kcal", "plate", "fork", "body", "lean"],
    suffixes: ["va", "io", "ly", "za", "go", "iq", "pal", "mate", "wise", "scale", "lyx", "ora", "iva", "zy"]
  },
  language: {
    tokens: ["word", "words", "learn", "vocab", "vocabulary", "language", "speak", "flashcard", "cards", "travel", "passport"],
    roots: ["word", "lexi", "vocab", "lingo", "speak", "phrase", "card", "gloss", "poly"],
    suffixes: ["pop", "ly", "io", "go", "va", "wise", "mate", "pal", "flow", "loop"]
  },
  utility: {
    tokens: ["focus", "task", "habit", "note", "scan", "lock", "timer", "track", "daily", "simple"],
    roots: ["focus", "task", "habit", "note", "scan", "lock", "timer", "track", "daily", "flow"],
    suffixes: ["ly", "io", "go", "va", "mate", "pal", "wise", "kit", "loop"]
  }
};

const HEALTH_GENRES = new Set(["Health & Fitness", "Food & Drink", "Medical"]);

function usage() {
  console.log(`ASO Scout ${VERSION}

Usage:
  aso-scout [options] <name...>
  aso-scout --names names.txt [options]
  aso-scout generate --profile calories --count 100 [options]

Options:
  --names <file>          Read candidate names from a newline-separated file
  --country <code>        App Store / Google Play country code. Default: ${DEFAULT_COUNTRY}
  --domains <list>        Comma-separated TLDs to check. Default: ${DEFAULT_DOMAINS.join(",")}
  --profile <name>        Keyword profile: ${Object.keys(PROFILES).join(", ")}. Default: calories
  --limit <number>        App Store result limit. Default: ${DEFAULT_LIMIT}
  --json                  Print JSON instead of a table
  --csv <file>            Write CSV report
  --markdown <file>       Write Markdown report
  --cache <file>          Cache HTTP/DNS/RDAP results
  --cache-ttl <value>     Cache TTL, for example 12h, 2d, 30m. Default: 24h
  --no-app-store          Skip App Store checks
  --no-google-play        Skip Google Play checks
  --no-domains            Skip domain DNS/RDAP checks
  --no-rdap               Skip RDAP registration checks
  --help                  Show this help

Generate options:
  --count <number>        Number of generated names. Default: 50
  --style <name>          short, brand, descriptive. Default: short

Examples:
  aso-scout Bitescale Mealva Gramva
  aso-scout --names examples/names.txt --profile calories --country us
  aso-scout --domains com,app,io,co --csv report.csv --markdown report.md Bitescale
  aso-scout generate --profile calories --count 100 --no-google-play
`);
}

function parseArgs(argv) {
  const args = {
    command: "inspect",
    country: DEFAULT_COUNTRY,
    domains: DEFAULT_DOMAINS,
    profile: "calories",
    limit: DEFAULT_LIMIT,
    appStore: true,
    googlePlay: true,
    domainsEnabled: true,
    rdap: true,
    json: false,
    count: 50,
    style: "short",
    names: []
  };

  const items = [...argv];
  if (items[0] === "generate") {
    args.command = "generate";
    items.shift();
  }

  for (let i = 0; i < items.length; i += 1) {
    const arg = items[i];
    const next = () => {
      i += 1;
      if (i >= items.length) throw new Error(`Missing value for ${arg}`);
      return items[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--names") args.namesFile = next();
    else if (arg === "--country") args.country = next().toLowerCase();
    else if (arg === "--domains") args.domains = splitList(next()).map(cleanTld);
    else if (arg === "--profile") args.profile = next().toLowerCase();
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--count") args.count = Number(next());
    else if (arg === "--style") args.style = next().toLowerCase();
    else if (arg === "--json") args.json = true;
    else if (arg === "--csv") args.csv = next();
    else if (arg === "--markdown") args.markdown = next();
    else if (arg === "--cache") args.cachePath = next();
    else if (arg === "--cache-ttl") args.cacheTtlMs = parseDuration(next());
    else if (arg === "--no-app-store") args.appStore = false;
    else if (arg === "--no-google-play") args.googlePlay = false;
    else if (arg === "--no-domains") args.domainsEnabled = false;
    else if (arg === "--no-rdap") args.rdap = false;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else args.names.push(arg);
  }

  if (!PROFILES[args.profile]) throw new Error(`Unknown profile "${args.profile}". Use: ${Object.keys(PROFILES).join(", ")}`);
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) throw new Error("--limit must be an integer from 1 to 200");
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 5000) throw new Error("--count must be an integer from 1 to 5000");
  if (!["short", "brand", "descriptive"].includes(args.style)) throw new Error("--style must be short, brand, or descriptive");

  args.cacheTtlMs ??= DEFAULT_CACHE_TTL_MS;
  args.domains = args.domains.filter(Boolean);
  return args;
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+)(m|h|d)?$/i);
  if (!match) throw new Error("--cache-ttl must look like 30m, 12h, or 2d");
  const amount = Number(match[1]);
  const unit = (match[2] || "h").toLowerCase();
  const multipliers = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[unit];
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

class CacheStore {
  constructor(path, ttlMs) {
    this.path = path;
    this.ttlMs = ttlMs;
    this.data = {};
  }

  async load() {
    if (!this.path) return;
    try {
      this.data = JSON.parse(await fs.readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async save() {
    if (!this.path) return;
    await fs.writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  get(key) {
    const entry = this.data[key];
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > this.ttlMs) return undefined;
    return entry.value;
  }

  set(key, value) {
    if (!this.path) return;
    this.data[key] = { storedAt: Date.now(), value };
  }
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

  if (args.command === "generate") {
    names.push(...generateNames(args));
  }

  return Array.from(new Set(names.map(normalizeName).filter(Boolean)));
}

function generateNames({ profile, count, style }) {
  const { roots, suffixes } = PROFILES[profile];
  const candidates = new Set();
  const extraSuffixes = style === "descriptive" ? ["tracker", "counter", "coach", "scan"] : suffixes;

  for (const root of roots) {
    for (const suffix of extraSuffixes) {
      if (root.toLowerCase().endsWith(suffix.toLowerCase())) continue;
      candidates.add(toPascal(`${root}${suffix}`));
      if (style !== "short") candidates.add(toPascal(`${root}-${suffix}`));
    }
  }

  for (const first of roots) {
    for (const second of roots) {
      if (first === second) continue;
      const joined = `${first}${second}`;
      if (joined.length <= 14) candidates.add(toPascal(joined));
    }
  }

  return Array.from(candidates)
    .filter((name) => name.length >= 5 && name.length <= 18)
    .slice(0, count);
}

function toPascal(value) {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

async function fetchText(url, cache, attempt = 1) {
  const key = `http:${url}`;
  const cached = cache?.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "aso-scout/0.2 (+https://github.com/mladishiis/aso-scout)" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    cache?.set(key, text);
    return text;
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return fetchText(url, cache, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, cache) {
  return JSON.parse(await fetchText(url, cache));
}

async function checkAppStore(name, { country, limit }, cache) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", name);
  url.searchParams.set("entity", "software");
  url.searchParams.set("country", country);
  url.searchParams.set("limit", String(limit));

  try {
    const json = await fetchJson(url, cache);
    const nameKey = normalizeCompare(name);
    const results = (json.results || []).map((item) => {
      const similarity = similarityScore(nameKey, normalizeCompare(item.trackName));
      return {
        trackName: item.trackName,
        artistName: item.artistName,
        primaryGenreName: item.primaryGenreName,
        trackViewUrl: item.trackViewUrl,
        bundleId: item.bundleId,
        similarity
      };
    });

    const exact = results.filter((item) => normalizeCompare(item.trackName) === nameKey);
    const close = results
      .filter((item) => normalizeCompare(item.trackName) !== nameKey && isCloseMatch(nameKey, normalizeCompare(item.trackName), item.similarity))
      .sort((a, b) => b.similarity - a.similarity);
    const categoryConflicts = results.filter((item) => item.similarity >= 0.72 && HEALTH_GENRES.has(item.primaryGenreName));

    return { ok: true, url: url.toString(), count: results.length, exact, close: close.slice(0, 5), categoryConflicts: categoryConflicts.slice(0, 5), top: results.slice(0, 5) };
  } catch (error) {
    return { ok: false, url: url.toString(), error: error.message, count: 0, exact: [], close: [], categoryConflicts: [], top: [] };
  }
}

function isCloseMatch(nameKey, trackKey, similarity) {
  if (!nameKey || !trackKey) return false;
  return trackKey.includes(nameKey) || nameKey.includes(trackKey) || similarity >= 0.78;
}

async function checkGooglePlay(name, { country }, cache) {
  const url = new URL("https://play.google.com/store/search");
  url.searchParams.set("q", `"${name}"`);
  url.searchParams.set("c", "apps");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", country.toUpperCase());

  try {
    const html = await fetchText(url, cache);
    const nameKey = normalizeCompare(name);
    const normalizedHtml = normalizeCompare(html);
    const exactMentions = countOccurrences(normalizedHtml, nameKey);
    const titleLike = extractGooglePlayTitleCandidates(html, name)
      .map((title) => ({ title, similarity: similarityScore(nameKey, normalizeCompare(title)) }))
      .filter((item) => isCloseMatch(nameKey, normalizeCompare(item.title), item.similarity))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    return { ok: true, url: url.toString(), exactMentions, titleLike };
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
    /"name"\s*:\s*"([^"]{1,90})"/g,
    /aria-label="([^"]{1,90})"/g,
    /<span[^>]*>([^<]{1,90})<\/span>/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const value = decodeHtml(match[1]).replace(/\s+/g, " ").trim();
      if (!value || value.length < 3 || /^[•·\-\s]+$/.test(value)) continue;
      const valueKey = normalizeCompare(value);
      if (valueKey.includes(nameKey) || nameKey.includes(valueKey) || similarityScore(nameKey, valueKey) >= 0.78) {
        candidates.add(value);
      }
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

async function checkDomains(name, tlds, rdapEnabled, cache) {
  const slug = slugForDomain(name);
  if (!slug) return [];

  return Promise.all(tlds.map(async (tld) => {
    const domain = `${slug}.${tld}`;
    const dnsStatus = await checkDns(domain, cache);
    const rdapStatus = rdapEnabled ? await checkRdap(domain, cache) : { status: "skipped" };
    return { domain, dns: dnsStatus, rdap: rdapStatus, status: combinedDomainStatus(dnsStatus, rdapStatus) };
  }));
}

async function checkDns(domain, cache) {
  const key = `dns:${domain}`;
  const cached = cache?.get(key);
  if (cached) return cached;

  let result;
  try {
    await dns.lookup(domain);
    result = { status: "has-dns" };
  } catch (error) {
    if (["ENOTFOUND", "ENODATA"].includes(error.code)) result = { status: "no-dns" };
    else result = { status: "unknown", error: error.code || error.message };
  }
  cache?.set(key, result);
  return result;
}

async function checkRdap(domain, cache) {
  const key = `rdap:${domain}`;
  const cached = cache?.get(key);
  if (cached) return cached;

  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  let result;
  try {
    const response = await fetchWithTimeout(url, { headers: { "User-Agent": "aso-scout/0.2" } });
    if (response.status === 404) result = { status: "not-found" };
    else if (response.ok) result = { status: "registered" };
    else result = { status: "unknown", error: `HTTP ${response.status}` };
  } catch (error) {
    result = { status: "unknown", error: error.message };
  }
  cache?.set(key, result);
  return result;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function combinedDomainStatus(dnsStatus, rdapStatus) {
  if (rdapStatus.status === "registered") return "registered";
  if (dnsStatus.status === "has-dns") return "has-dns";
  if (rdapStatus.status === "not-found" && dnsStatus.status === "no-dns") return "available-ish";
  if (dnsStatus.status === "no-dns") return "no-dns";
  return "unknown";
}

function scoreName(name, checks, profile) {
  let score = 70;
  const reasons = [];
  const tokens = keywordSignals(name, profile);

  if (checks.appStore?.ok) {
    if (checks.appStore.exact.length > 0) {
      score -= 45;
      reasons.push(`App Store exact match: ${checks.appStore.exact[0].trackName}`);
    }
    if (checks.appStore.close.length > 0) {
      score -= Math.min(22, checks.appStore.close.length * 6);
      reasons.push(`App Store close matches: ${checks.appStore.close.map((item) => item.trackName).join(", ")}`);
    }
    if (checks.appStore.categoryConflicts.length > 0) {
      score -= Math.min(14, checks.appStore.categoryConflicts.length * 5);
      reasons.push(`Category conflicts: ${checks.appStore.categoryConflicts.map((item) => `${item.trackName} (${item.primaryGenreName})`).join(", ")}`);
    }
  } else if (checks.appStore) {
    score -= 5;
    reasons.push(`App Store check failed: ${checks.appStore.error}`);
  }

  if (checks.googlePlay?.ok) {
    if (checks.googlePlay.titleLike.length > 0) {
      score -= Math.min(18, checks.googlePlay.titleLike.length * 6);
      reasons.push(`Google Play title-like hits: ${checks.googlePlay.titleLike.map((item) => item.title).join(", ")}`);
    }
  } else if (checks.googlePlay) {
    score -= 3;
    reasons.push(`Google Play check failed: ${checks.googlePlay.error}`);
  }

  const domainIssues = (checks.domains || []).filter((item) => ["registered", "has-dns"].includes(item.status));
  if (domainIssues.length > 0) {
    score -= Math.min(20, domainIssues.length * 6);
    reasons.push(`Domain issues: ${domainIssues.map((item) => `${item.domain} ${item.status}`).join(", ")}`);
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
  return { score, risk: score >= 75 ? "low" : score >= 50 ? "medium" : "high", reasons };
}

function keywordSignals(name, profile) {
  const key = normalizeCompare(name);
  return PROFILES[profile].tokens.filter((token) => key.includes(token));
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  const maxLength = Math.max(a.length, b.length);
  return maxLength === 0 ? 1 : 1 - distance / maxLength;
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

async function inspectName(name, args, cache) {
  const checks = {};
  const tasks = [];
  if (args.appStore) tasks.push(checkAppStore(name, args, cache).then((result) => { checks.appStore = result; }));
  if (args.googlePlay) tasks.push(checkGooglePlay(name, args, cache).then((result) => { checks.googlePlay = result; }));
  if (args.domainsEnabled) tasks.push(checkDomains(name, args.domains, args.rdap, cache).then((result) => { checks.domains = result; }));
  await Promise.all(tasks);
  return { name, ...scoreName(name, checks, args.profile), checks };
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

  const columns = [["Name", "name"], ["Score", "score"], ["Risk", "risk"], ["App Store", "appStore"], ["Google Play", "googlePlay"], ["Domains", "domains"]];
  const widths = columns.map(([label, key]) => Math.min(48, Math.max(label.length, ...rows.map((row) => row[key].length))));

  console.log(columns.map(([label], index) => pad(label, widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(columns.map(([, key], index) => pad(truncate(row[key], widths[index]), widths[index])).join("  "));
  }

  console.log("\nNotes:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.reasons.slice(0, 4).join(" | ") || "No major signals."}`);
  }
}

function summarizeAppStore(check) {
  if (!check) return "skipped";
  if (!check.ok) return `error: ${check.error}`;
  return `exact ${check.exact.length}, close ${check.close.length}, category ${check.categoryConflicts.length}`;
}

function summarizeGooglePlay(check) {
  if (!check) return "skipped";
  if (!check.ok) return `error: ${check.error}`;
  return `titles ${check.titleLike.length}`;
}

function summarizeDomains(domains) {
  if (!domains) return "skipped";
  return domains.map((item) => `${item.domain.replace(/^[^.]+\./, ".")} ${item.status}`).join(", ");
}

function toCsv(results) {
  const rows = [["name", "score", "risk", "app_store_exact", "app_store_close", "google_play_titles", "domains", "reasons"]];
  for (const result of results) {
    rows.push([
      result.name,
      result.score,
      result.risk,
      result.checks.appStore?.exact?.map((item) => item.trackName).join("; ") || "",
      result.checks.appStore?.close?.map((item) => item.trackName).join("; ") || "",
      result.checks.googlePlay?.titleLike?.map((item) => item.title).join("; ") || "",
      result.checks.domains?.map((item) => `${item.domain}:${item.status}`).join("; ") || "",
      result.reasons.join(" | ")
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toMarkdown(results) {
  const lines = [
    "# ASO Scout Report",
    "",
    "| Name | Score | Risk | App Store | Google Play | Domains |",
    "|---|---:|---|---|---|---|"
  ];
  for (const result of results) {
    lines.push(`| ${escapeMd(result.name)} | ${result.score} | ${result.risk} | ${escapeMd(summarizeAppStore(result.checks.appStore))} | ${escapeMd(summarizeGooglePlay(result.checks.googlePlay))} | ${escapeMd(summarizeDomains(result.checks.domains))} |`);
  }
  lines.push("", "## Notes", "");
  for (const result of results) {
    lines.push(`- **${escapeMd(result.name)}**: ${escapeMd(result.reasons.join(" | ") || "No major signals.")}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeMd(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
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

  const cache = new CacheStore(args.cachePath, args.cacheTtlMs);
  await cache.load();

  const names = await readNames(args);
  if (names.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const name of names) {
    results.push(await inspectName(name, args, cache));
  }

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  if (args.csv) await fs.writeFile(args.csv, toCsv(results));
  if (args.markdown) await fs.writeFile(args.markdown, toMarkdown(results));
  await cache.save();

  if (args.json) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), profile: args.profile, results }, null, 2));
  else printTable(results);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
