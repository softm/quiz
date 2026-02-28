#!/usr/bin/env node
import fs from "node:fs";

function usage() {
  console.log("Usage: node ./scripts/apply-gpt-answers.mjs <base-json-path> [--gpt-file <path>] [--out <path>]");
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

function extractAnswersFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.answers)) return obj.answers;
  } catch {}
  if (raw.startsWith("[")) {
    try {
      return JSON.parse(raw.replace(/,\s*]/g, "]"));
    } catch {}
  }
  const keyIdx = raw.indexOf('"answers"');
  const start = keyIdx >= 0 ? raw.indexOf("[", keyIdx) : raw.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "[") depth += 1;
    if (raw[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1).replace(/,\s*]/g, "]"));
  } catch {
    return null;
  }
}

function to100(arr) {
  if (!Array.isArray(arr)) return null;
  if (arr.length === 101 && (arr[0] == null)) return arr.slice(1, 101).map((v) => Number(v));
  if (arr.length === 100) return arr.slice(0, 100).map((v) => Number(v));
  return null;
}

function formatAnswersArray(answers, baseIndent = 2, perLine = 5) {
  const indent = " ".repeat(baseIndent);
  const valueIndent = " ".repeat(baseIndent + 2);
  const last = answers.length - 1;
  const lines = [];
  for (let i = 0; i < answers.length; i += perLine) {
    const chunk = [];
    for (let j = 0; j < perLine && i + j < answers.length; j++) {
      const idx = i + j;
      const raw = String(answers[idx]);
      chunk.push(idx < last ? `${raw},` : raw);
    }
    lines.push(`${valueIndent}${chunk.join(" ")}`);
  }
  return `[\n${lines.join("\n")}\n${indent}]`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    usage();
    process.exit(1);
  }
  const basePath = args[0];
  let gptFile = "";
  let outPath = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--gpt-file" && args[i + 1]) {
      gptFile = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--out" && args[i + 1]) {
      outPath = args[i + 1];
      i += 1;
    }
  }
  if (!outPath) outPath = basePath;

  const baseObj = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const gptText = gptFile ? fs.readFileSync(gptFile, "utf8") : await readStdin();
  const parsed = to100(extractAnswersFromText(gptText));
  if (!parsed || parsed.length !== 100) {
    console.error("[ERR] GPT answers parse failed or not 100-length");
    process.exit(1);
  }
  const invalid = parsed.filter((v) => !Number.isInteger(v) || v < 1 || v > 5).length;
  if (invalid > 0) {
    console.error(`[ERR] invalid values: ${invalid}`);
    process.exit(1);
  }

  const next = {
    ...baseObj,
    generatedAt: new Date().toISOString(),
    count: 100,
    answers: parsed
  };
  const text = [
    "{",
    `  "questionNo": ${JSON.stringify(String(next.questionNo || ""))},`,
    `  "questionNm": ${JSON.stringify(String(next.questionNm || ""))},`,
    `  "sourcePdf": ${JSON.stringify(String(next.sourcePdf || ""))},`,
    `  "generatedAt": ${JSON.stringify(String(next.generatedAt))},`,
    `  "count": 100,`,
    `  "answers": ${formatAnswersArray(parsed, 2, 5)}`,
    "}"
  ].join("\n");

  fs.writeFileSync(outPath, `${text}\n`, "utf8");
  console.log(`[OK] wrote: ${outPath}`);
}

main();
