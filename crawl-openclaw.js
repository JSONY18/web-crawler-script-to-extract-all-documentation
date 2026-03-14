#!/usr/bin/env node
/**
 * OpenClaw Docs Crawler
 * ─────────────────────────────────────────────────────────────────
 * Crawls https://docs.openclaw.ai/zh-CN and saves every page as a
 * Markdown file, preserving the original URL directory structure.
 *
 * Usage:
 *   node crawl-openclaw.js
 *
 * Install dependencies first:
 *   npm install axios cheerio turndown robots-parser p-queue chalk
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const axios        = require("axios");
const cheerio      = require("cheerio");
const TurndownService = require("turndown");
const RobotsParser = require("robots-parser");
const PQueue       = require("p-queue").default ?? require("p-queue");
const fs           = require("fs");
const path         = require("path");
const { URL }      = require("url");

// ── try to load chalk (optional, graceful fallback) ──────────────
let chalk;
try { chalk = require("chalk"); }
catch { chalk = { green: s=>s, yellow: s=>s, red: s=>s, cyan: s=>s, gray: s=>s, bold: s=>s }; }

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  baseUrl:    "https://docs.openclaw.ai/zh-CN",
  origin:     "https://docs.openclaw.ai",
  pathPrefix: "/zh-CN",                                   // only follow links under this prefix
  outDir:     "/home/yxs/.openclaw/workspace/docs-openclaw",
  concurrency: 3,                                         // parallel requests
  delayMs:    400,                                        // ms between requests (rate-limit)
  timeout:    15_000,                                     // request timeout ms
  maxRetries: 3,
  userAgent:  "Mozilla/5.0 (compatible; DocsBot/1.0; +https://github.com/local)",
  respectRobots: true,
};

// ═══════════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════════
const visited    = new Set();          // normalised URLs already processed
const discovered = new Set();          // all URLs ever enqueued
let   robotsRules = null;              // robots-parser instance

// Turndown: HTML → Markdown
const td = new TurndownService({
  headingStyle:   "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Keep <table> as markdown table (via gfm-like conversion)
td.addRule("table", {
  filter: "table",
  replacement(_, node) {
    // Let cheerio serialise then re-parse so we can walk rows
    return "\n\n" + tableToMd(node) + "\n\n";
  },
});

// ═══════════════════════════════════════════════════════════════════
// ROBOTS.TXT
// ═══════════════════════════════════════════════════════════════════
async function loadRobots() {
  try {
    const res = await axios.get(`${CONFIG.origin}/robots.txt`, {
      timeout: 8000,
      headers: { "User-Agent": CONFIG.userAgent },
      validateStatus: () => true,
    });
    if (res.status === 200) {
      robotsRules = RobotsParser(`${CONFIG.origin}/robots.txt`, res.data);
      console.log(chalk.gray("  ✔ robots.txt loaded"));
    } else {
      console.log(chalk.gray("  ℹ  No robots.txt found (HTTP " + res.status + ") — continuing"));
    }
  } catch {
    console.log(chalk.gray("  ℹ  robots.txt unreachable — continuing"));
  }
}

function isAllowed(url) {
  if (!CONFIG.respectRobots || !robotsRules) return true;
  return robotsRules.isAllowed(url, CONFIG.userAgent) !== false;
}

// ═══════════════════════════════════════════════════════════════════
// HTTP  (with retry + exponential back-off)
// ═══════════════════════════════════════════════════════════════════
async function fetchHtml(url, attempt = 1) {
  try {
    const res = await axios.get(url, {
      timeout: CONFIG.timeout,
      headers: {
        "User-Agent": CONFIG.userAgent,
        "Accept":     "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      maxRedirects: 5,
    });
    return res.data;
  } catch (err) {
    if (attempt < CONFIG.maxRetries) {
      const wait = attempt * 1500;
      console.warn(chalk.yellow(`    ⚠  Retry ${attempt}/${CONFIG.maxRetries} for ${url} (${wait}ms)`));
      await sleep(wait);
      return fetchHtml(url, attempt + 1);
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// LINK EXTRACTION
// ═══════════════════════════════════════════════════════════════════
function extractLinks($, currentUrl) {
  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href").trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) return;
    try {
      const resolved = new URL(href, currentUrl);
      resolved.hash = "";                       // strip fragment
      const full = resolved.href.replace(/\/$/, ""); // strip trailing slash
      const parsed = new URL(full);
      if (
        parsed.hostname === new URL(CONFIG.origin).hostname &&
        parsed.pathname.startsWith(CONFIG.pathPrefix)
      ) {
        links.push(full);
      }
    } catch { /* ignore malformed */ }
  });
  return [...new Set(links)];
}

// ═══════════════════════════════════════════════════════════════════
// CONTENT EXTRACTION
// ═══════════════════════════════════════════════════════════════════
// Priority selectors for main content (Docusaurus / Mintlify / GitBook)
const CONTENT_SELECTORS = [
  "article",
  "main .markdown",
  "main [class*='content']",
  "main [class*='prose']",
  ".doc-content",
  "[class*='docContent']",
  "[class*='articleBody']",
  "main",
  "#content",
  ".content",
];

// Noise selectors to remove before conversion
const NOISE_SELECTORS = [
  "nav", "header", "footer", "aside",
  "[class*='sidebar']", "[class*='toc']",
  "[class*='breadcrumb']", "[class*='pagination']",
  "[class*='Sidebar']", "[class*='NavBar']",
  "[class*='footer']", "[class*='Footer']",
  "[class*='cookie']", "[class*='banner']",
  "script", "style", "noscript",
];

function extractMainContent($) {
  // Remove noise first
  NOISE_SELECTORS.forEach(sel => $(sel).remove());

  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) {
      return el.html() || "";
    }
  }
  return $("body").html() || "";
}

function extractTitle($) {
  return (
    $("h1").first().text().trim() ||
    $("title").first().text().trim().split("|")[0].trim() ||
    "Untitled"
  );
}

// ═══════════════════════════════════════════════════════════════════
// URL → FILE PATH
// ═══════════════════════════════════════════════════════════════════
function urlToFilePath(url) {
  const parsed = new URL(url);
  let   segments = parsed.pathname
        .replace(CONFIG.pathPrefix, "")
        .split("/")
        .filter(Boolean)
        .map(s => slugify(s));

  if (segments.length === 0) {
    return path.join(CONFIG.outDir, "index.md");
  }
  // Last segment becomes the filename; rest become directories
  const last = segments.pop();
  const dir  = path.join(CONFIG.outDir, ...segments);
  return path.join(dir, `${last}.md`);
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff._-]/g, "-")  // keep CJK, alphanumeric, . _ -
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ═══════════════════════════════════════════════════════════════════
// TABLE HELPER (basic HTML table → GFM)
// ═══════════════════════════════════════════════════════════════════
function tableToMd(node) {
  try {
    const $ = cheerio.load(node.toString ? node.toString() : "");
    const rows = [];
    $("tr").each((_, tr) => {
      const cells = [];
      $(tr).find("th,td").each((_, td) => {
        cells.push($(td).text().replace(/\|/g, "\\|").replace(/\n/g, " ").trim());
      });
      rows.push("| " + cells.join(" | ") + " |");
    });
    if (rows.length < 1) return "";
    const sep = "| " + rows[0].slice(2, -2).split(" | ").map(() => "---").join(" | ") + " |";
    rows.splice(1, 0, sep);
    return rows.join("\n");
  } catch { return ""; }
}

// ═══════════════════════════════════════════════════════════════════
// SAVE MARKDOWN
// ═══════════════════════════════════════════════════════════════════
function saveMd(filePath, title, url, markdown) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source: "${url}"`,
    `crawled_at: "${new Date().toISOString()}"`,
    "---",
    "",
  ].join("\n");

  fs.writeFileSync(filePath, frontmatter + markdown, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════
// PROCESS ONE PAGE
// ═══════════════════════════════════════════════════════════════════
async function processPage(url, queue) {
  if (visited.has(url)) return;
  visited.add(url);

  if (!isAllowed(url)) {
    console.log(chalk.yellow(`  🚫 Blocked by robots.txt: ${url}`));
    return;
  }

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    console.error(chalk.red(`  ✗ Failed: ${url} — ${err.message}`));
    return;
  }

  const $     = cheerio.load(html);
  const title = extractTitle($);
  const contentHtml = extractMainContent($);

  // Convert HTML → Markdown
  let markdown = "";
  try {
    markdown = td.turndown(contentHtml);
    // Clean up excessive blank lines
    markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();
  } catch (err) {
    console.warn(chalk.yellow(`  ⚠  Turndown error on ${url}: ${err.message}`));
    // Fallback: plain text
    markdown = cheerio.load(contentHtml).text().trim();
  }

  // Save file
  const filePath = urlToFilePath(url);
  saveMd(filePath, title, url, markdown);
  console.log(chalk.green(`  ✔ [${visited.size}] ${title}`));
  console.log(chalk.gray(`       → ${filePath}`));

  // Enqueue new links
  const links = extractLinks($, url);
  let newCount = 0;
  for (const link of links) {
    if (!discovered.has(link)) {
      discovered.add(link);
      newCount++;
      queue.add(() => processPage(link, queue));
    }
  }
  if (newCount > 0) {
    console.log(chalk.gray(`       + ${newCount} new link(s) discovered`));
  }

  // Rate-limit courtesy delay
  await sleep(CONFIG.delayMs);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log(chalk.bold.cyan("\n╔══════════════════════════════════════════╗"));
  console.log(chalk.bold.cyan("║       OpenClaw Docs Crawler v1.0         ║"));
  console.log(chalk.bold.cyan("╚══════════════════════════════════════════╝\n"));
  console.log(chalk.cyan(`  Base URL : ${CONFIG.baseUrl}`));
  console.log(chalk.cyan(`  Out Dir  : ${CONFIG.outDir}`));
  console.log(chalk.cyan(`  Workers  : ${CONFIG.concurrency}`));
  console.log(chalk.cyan(`  Delay    : ${CONFIG.delayMs}ms\n`));

  // Ensure output directory exists
  fs.mkdirSync(CONFIG.outDir, { recursive: true });

  // Load robots.txt
  await loadRobots();

  // Bounded concurrency queue
  const queue = new PQueue({ concurrency: CONFIG.concurrency });

  // Seed with base URL
  const seed = CONFIG.baseUrl.replace(/\/$/, "");
  discovered.add(seed);
  queue.add(() => processPage(seed, queue));

  // Wait for all tasks to complete
  await queue.onIdle();

  console.log(chalk.bold.green(`\n✅ Crawl complete!`));
  console.log(chalk.green(`   Pages saved : ${visited.size}`));
  console.log(chalk.green(`   Output dir  : ${CONFIG.outDir}`));
}

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Run ──────────────────────────────────────────────────────────
main().catch(err => {
  console.error(chalk.red("\n💥 Fatal error:"), err);
  process.exit(1);
});
