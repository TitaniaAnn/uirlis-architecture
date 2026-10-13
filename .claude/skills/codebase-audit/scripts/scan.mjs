#!/usr/bin/env node
// Mechanical pass for the codebase-audit skill. Zero dependencies so it runs
// before `npm ci`. Produces candidates, not verdicts: every hit still gets read
// in context before it goes in the report.
//
//   node .claude/skills/codebase-audit/scripts/scan.mjs [--root .] [--out dir]
//        [--min-lines 6] [--tools] [--only rules,dupes,names,tools]
//
// Writes <out>/scan.json and <out>/scan.md. Exit code is always 0 unless the
// scanner itself breaks; findings are data, not failures.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { root: process.cwd(), out: null, minLines: 6, tools: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--min-lines") args.minLines = Number(argv[++i]);
    else if (a === "--tools") args.tools = true;
    else if (a === "--only") args.only = new Set(argv[++i].split(","));
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).join("\n"));
      process.exit(0);
    }
  }
  args.out ??= join(args.root, ".audit");
  return args;
}

// ---------------------------------------------------------------- file walk

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".sql", ".css"]);
const ALWAYS_SKIP = new Set([
  "node_modules", ".git", ".next", "out", "build", "dist", "coverage", ".audit",
  ".vercel", ".turbo", "playwright-report", "test-results",
]);

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += "(?:" + glob.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp("^" + re + "$");
}
const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

function walk(root, ignore) {
  const files = [];
  (function rec(dir) {
    for (const name of readdirSync(dir)) {
      if (ALWAYS_SKIP.has(name)) continue;
      const abs = join(dir, name);
      const rel = relative(root, abs).split("\\").join("/");
      if (matchesAny(rel, ignore)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) rec(abs);
      else if (SOURCE_EXT.has(extname(name)) && st.size < 512_000) files.push(rel);
    }
  })(root);
  return files.sort();
}

// ---------------------------------------------------------------- rules

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Blank out comments (keeping offsets and newlines) so rules match code, not
// the prose explaining why the code avoids the thing the rule looks for.
function maskComments(text, ext) {
  const sql = ext === ".sql";
  const css = ext === ".css";
  const out = text.split("");
  let i = 0;
  let quote = null;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      if (c === "\\" && !sql) i += 2;
      else { if (c === quote) quote = null; i++; }
      continue;
    }
    if (c === "'" || (!sql && (c === '"' || c === "`"))) { quote = c; i++; continue; }
    const lineComment = sql ? c === "-" && n === "-" : !css && c === "/" && n === "/";
    if (lineComment) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

function runRules(root, files, rules) {
  const findings = [];
  for (const rule of rules) {
    const scope = files.filter(
      (f) => matchesAny(f, rule.include ?? ["**"]) && !matchesAny(f, rule.exclude ?? []),
    );
    for (const f of scope) {
      const raw = readFileSync(join(root, f), "utf8");
      // Most rules care about code only; `inComments: true` (e.g. TODO markers)
      // matches the raw text. Excerpts always come from the raw text.
      const text = rule.inComments ? raw : maskComments(raw, extname(f));
      if (rule.onlyIfFileMatches && !new RegExp(rule.onlyIfFileMatches, "mi").test(text)) continue;
      if (rule.skipIfFileMatches && new RegExp(rule.skipIfFileMatches, "mi").test(text)) continue;

      if (rule.type === "file-must-match") {
        if (!new RegExp(rule.pattern, rule.flags ?? "m").test(text)) {
          findings.push({ rule: rule.id, severity: rule.severity, file: f, line: 1, message: rule.message, excerpt: "" });
        }
        continue;
      }

      const flags = (rule.flags ?? "") + (rule.flags?.includes("g") ? "" : "g");
      const re = new RegExp(rule.pattern, flags);
      let m;
      let count = 0;
      while ((m = re.exec(text)) && count < 50) {
        const line = lineOf(text, m.index);
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: f,
          line,
          message: rule.message,
          excerpt: raw.split("\n")[line - 1].trim().slice(0, 160),
        });
        count++;
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- duplicates

// Lines that carry no logic of their own. Matching on them produces noise like
// "these two files both close three braces in a row".
const TRIVIAL = /^(?:[{}()[\];,]+|\)\s*[;,]?|\}\s*\)?[;,]?|<\/?>|<\/[\w.]+>|else|try|finally|return;?|break;|default:|"use (?:client|server)";?|import .*|export \{.*\};?|\*.*|\/\*.*)$/;

function normalize(line, ext) {
  let s = line;
  if (ext === ".sql") s = s.replace(/--.*$/, "");
  else s = s.replace(/\/\/.*$/, "");
  s = s.trim().replace(/\s+/g, " ");
  return s;
}

function findDuplicates(root, files, minLines, ignore) {
  // Index every window of `minLines` consecutive non-trivial lines.
  const windows = new Map(); // key -> [{file, idx}]
  const fileLines = new Map(); // file -> [{text, line}]
  for (const f of files) {
    if (matchesAny(f, ignore)) continue;
    const ext = extname(f);
    const raw = readFileSync(join(root, f), "utf8").split("\n");
    const sig = [];
    let inBlockComment = false;
    raw.forEach((l, i) => {
      const t = l.trim();
      if (inBlockComment) { if (t.includes("*/")) inBlockComment = false; return; }
      if (t.startsWith("/*") && !t.includes("*/")) { inBlockComment = true; return; }
      const n = normalize(l, ext);
      if (!n || n.length < 4 || TRIVIAL.test(n)) return;
      sig.push({ text: n, line: i + 1 });
    });
    fileLines.set(f, sig);
    for (let i = 0; i + minLines <= sig.length; i++) {
      const key = sig.slice(i, i + minLines).map((s) => s.text).join("\n");
      if (key.length < minLines * 12) continue; // too short to matter
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push({ file: f, idx: i });
    }
  }

  // Keep windows seen in 2+ places, then grow each pair of starting points into
  // the longest run so one 40-line clone is one finding, not 35.
  const seen = new Set();
  const clones = [];
  for (const [, locs] of windows) {
    if (locs.length < 2) continue;
    const a = locs[0];
    for (const b of locs.slice(1)) {
      if (a.file === b.file && Math.abs(a.idx - b.idx) < minLines) continue;
      const pairKey = `${a.file}:${a.idx}|${b.file}:${b.idx}`;
      if (seen.has(pairKey)) continue;
      const la = fileLines.get(a.file);
      const lb = fileLines.get(b.file);
      let len = 0;
      while (
        a.idx + len < la.length && b.idx + len < lb.length &&
        la[a.idx + len].text === lb[b.idx + len].text &&
        !(a.file === b.file && a.idx + len === b.idx)
      ) {
        seen.add(`${a.file}:${a.idx + len}|${b.file}:${b.idx + len}`);
        len++;
      }
      if (len < minLines) continue;
      clones.push({
        lines: len,
        a: { file: a.file, start: la[a.idx].line, end: la[a.idx + len - 1].line },
        b: { file: b.file, start: lb[b.idx].line, end: lb[b.idx + len - 1].line },
        preview: la.slice(a.idx, a.idx + Math.min(len, 4)).map((s) => s.text),
      });
    }
  }
  return clones.sort((x, y) => y.lines - x.lines);
}

// ---------------------------------------------------------------- names

// The same top-level function/const name defined in more than one file is the
// cheapest signal of a helper that got re-implemented instead of imported.
function findRepeatedNames(root, files, ignore, allow) {
  const defs = new Map();
  const re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function))/gm;
  for (const f of files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|mts)$/.test(f) || matchesAny(f, ignore)) continue;
    const text = readFileSync(join(root, f), "utf8");
    let m;
    while ((m = re.exec(text))) {
      const name = m[1] ?? m[2];
      if (allow.includes(name)) continue;
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push({ file: f, line: lineOf(text, m.index) });
    }
  }
  return [...defs.entries()]
    .filter(([, locs]) => new Set(locs.map((l) => l.file)).size > 1)
    .map(([name, locs]) => ({ name, locations: locs }))
    .sort((a, b) => b.locations.length - a.locations.length);
}

// ---------------------------------------------------------------- tools

function runTools(root, tools) {
  const results = [];
  const haveModules = existsSync(join(root, "node_modules"));
  for (const t of tools) {
    if (t.needsNodeModules && !haveModules) {
      results.push({ name: t.name, skipped: "node_modules missing; run npm ci first" });
      continue;
    }
    const r = spawnSync(t.cmd, t.args, { cwd: root, encoding: "utf8", shell: false, timeout: t.timeoutMs ?? 600_000 });
    // 127 = command not found when the tool is wrapped in `sh -c`.
    if ((r.error && r.error.code === "ENOENT") || r.status === 127) {
      results.push({ name: t.name, skipped: r.status === 127 ? "command not found" : `${t.cmd} not installed` });
      continue;
    }
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    results.push({
      name: t.name,
      exitCode: r.status,
      ok: r.status === 0,
      // Tail is where the summary lives for tsc/eslint/node --test.
      output: output.length > 20_000 ? "…" + output.slice(-20_000) : output,
    });
  }
  return results;
}

// ---------------------------------------------------------------- report

function toMarkdown(r) {
  const out = [];
  out.push(`# Mechanical scan`, ``, `Root: \`${r.root}\` · ${r.fileCount} files · ${r.generatedAt}`, ``);
  out.push(`These are candidates. Read each one in context before reporting it.`, ``);

  if (r.tools) {
    out.push(`## Tools`, ``);
    for (const t of r.tools) {
      if (t.skipped) out.push(`- ${t.name}: skipped (${t.skipped})`);
      else out.push(`- ${t.name}: ${t.ok ? "pass" : `FAIL (exit ${t.exitCode})`}`);
    }
    out.push(``);
    for (const t of r.tools.filter((t) => !t.skipped && !t.ok)) {
      out.push(`### ${t.name} output (tail)`, "```", t.output.split("\n").slice(-60).join("\n"), "```", ``);
    }
  }

  if (r.rules) {
    const bySev = { error: [], warn: [], info: [] };
    for (const f of r.rules) (bySev[f.severity] ?? bySev.info).push(f);
    out.push(`## Rule hits (${r.rules.length})`, ``);
    for (const sev of ["error", "warn", "info"]) {
      if (!bySev[sev].length) continue;
      out.push(`### ${sev} (${bySev[sev].length})`, ``);
      const byRule = Map.groupBy ? Map.groupBy(bySev[sev], (f) => f.rule) : group(bySev[sev], (f) => f.rule);
      for (const [rule, hits] of byRule) {
        out.push(`**${rule}** — ${hits[0].message}`);
        for (const h of hits.slice(0, 25)) out.push(`- \`${h.file}:${h.line}\`${h.excerpt ? ` — \`${h.excerpt.replace(/`/g, "'")}\`` : ""}`);
        if (hits.length > 25) out.push(`- …and ${hits.length - 25} more (see scan.json)`);
        out.push(``);
      }
    }
  }

  if (r.duplicates) {
    out.push(`## Duplicate blocks (${r.duplicates.length})`, ``);
    for (const d of r.duplicates.slice(0, 40)) {
      out.push(`- ${d.lines} lines: \`${d.a.file}:${d.a.start}-${d.a.end}\` ≈ \`${d.b.file}:${d.b.start}-${d.b.end}\``);
      out.push(`  \`${d.preview[0].slice(0, 100).replace(/`/g, "'")}\``);
    }
    if (r.duplicates.length > 40) out.push(`- …and ${r.duplicates.length - 40} more`);
    out.push(``);
  }

  if (r.repeatedNames) {
    out.push(`## Same name defined in multiple files (${r.repeatedNames.length})`, ``);
    for (const n of r.repeatedNames.slice(0, 40)) {
      out.push(`- \`${n.name}\`: ${n.locations.map((l) => `\`${l.file}:${l.line}\``).join(", ")}`);
    }
    out.push(``);
  }
  return out.join("\n");
}

function group(arr, key) {
  const m = new Map();
  for (const x of arr) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const configPath = join(here, "..", "rules.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const files = walk(args.root, config.ignore ?? []);
const want = (k) => !args.only || args.only.has(k);

const report = { root: args.root, generatedAt: new Date().toISOString(), fileCount: files.length };
if (want("rules")) report.rules = runRules(args.root, files, config.rules ?? []);
if (want("dupes")) report.duplicates = findDuplicates(args.root, files, args.minLines, config.duplicateIgnore ?? []);
if (want("names")) report.repeatedNames = findRepeatedNames(args.root, files, config.duplicateIgnore ?? [], config.repeatedNameAllow ?? []);
if (args.tools && want("tools")) report.tools = runTools(args.root, config.tools ?? []);

mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "scan.json"), JSON.stringify(report, null, 2));
writeFileSync(join(args.out, "scan.md"), toMarkdown(report));

const summary = [
  `${files.length} files`,
  report.rules && `${report.rules.length} rule hits`,
  report.duplicates && `${report.duplicates.length} duplicate blocks`,
  report.repeatedNames && `${report.repeatedNames.length} repeated names`,
  report.tools && `tools: ${report.tools.map((t) => `${t.name}=${t.skipped ? "skip" : t.ok ? "ok" : "FAIL"}`).join(" ")}`,
].filter(Boolean).join(" · ");
console.log(`scan → ${relative(process.cwd(), join(args.out, "scan.md")) || "scan.md"}\n${summary}`);
