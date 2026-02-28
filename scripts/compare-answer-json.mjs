#!/usr/bin/env node
import fs from "node:fs";

function usage() {
  console.log("Usage: node ./scripts/compare-answer-json.mjs <base-json-path> [--gpt-file <path>]");
  console.log("If --gpt-file is omitted, reads GPT content from stdin.");
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

function normalizeAnswers(arr) {
  if (!Array.isArray(arr)) return null;
  if (arr.length === 101 && (arr[0] == null)) return arr.slice(1, 101).map((v) => Number(v));
  if (arr.length === 100) return arr.slice(0, 100).map((v) => Number(v));
  return null;
}

function extractAnswersFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // 1) full JSON
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.answers)) return normalizeAnswers(obj.answers);
  } catch {}

  // 2) JS/JSON array only
  if (raw.startsWith("[")) {
    try {
      return normalizeAnswers(JSON.parse(raw.replace(/,\s*]/g, "]")));
    } catch {}
  }

  // 3) snippet containing "answers": [...]
  const keyIdx = raw.indexOf('"answers"');
  const start = keyIdx >= 0 ? raw.indexOf("[", keyIdx) : raw.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const arrayText = raw.slice(start, end + 1);
  try {
    return normalizeAnswers(JSON.parse(arrayText.replace(/,\s*]/g, "]")));
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    usage();
    process.exit(1);
  }

  const basePath = args[0];
  let gptFile = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--gpt-file" && args[i + 1]) {
      gptFile = args[i + 1];
      i += 1;
    }
  }

  if (!fs.existsSync(basePath)) {
    console.error(`[ERR] base json not found: ${basePath}`);
    process.exit(1);
  }

  const baseObj = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const baseAnswers = normalizeAnswers(baseObj?.answers);
  if (!baseAnswers || baseAnswers.length !== 100) {
    console.error("[ERR] base json answers must have 100 (or 101 with index 0 padding)");
    process.exit(1);
  }

  const gptText = gptFile
    ? fs.readFileSync(gptFile, "utf8")
    : await readStdin();
  const gptAnswers = extractAnswersFromText(gptText);
  if (!gptAnswers || gptAnswers.length !== 100) {
    console.error("[ERR] GPT answers parse failed or not 100-length");
    process.exit(1);
  }

  const bad = gptAnswers.filter((v) => !Number.isInteger(v) || v < 1 || v > 5).length;
  if (bad > 0) {
    console.error(`[ERR] GPT answers contain invalid values: ${bad}`);
    process.exit(1);
  }

  const mismatches = [];
  for (let i = 0; i < 100; i++) {
    const q = i + 1;
    if (Number(baseAnswers[i]) !== Number(gptAnswers[i])) {
      mismatches.push({ q, base: baseAnswers[i], gpt: gptAnswers[i] });
    }
  }

  const agree = 100 - mismatches.length;
  console.log(`base=${basePath}`);
  console.log(`agree=${agree}/100, mismatch=${mismatches.length}`);
  if (mismatches.length) {
    console.log("mismatches:");
    for (const m of mismatches) {
      console.log(`- Q${m.q}: base=${m.base} gpt=${m.gpt}`);
    }
  }
}

main();
