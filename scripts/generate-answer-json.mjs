#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const questionJsonPath = path.join(root, "json", "question.json");

function normalizePdfPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return raw.replace(/^\.\//, "").replace(/^quiz\//, "");
}

function parseAnswerPairs(text) {
  const out = [];
  const normalized = String(text || "")
    .replace(/[①②③④⑤]/g, (m) => ({ "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5" }[m] || m));
  const lines = normalized.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);

  // 1차: 숫자/공백만 남긴 뒤 행 단위 페어 파싱(표 형태에 가장 강함)
  for (const line of lines) {
    const digitsOnly = line.replace(/[^\d]+/g, " ").replace(/\s+/g, " ").trim();
    if (!digitsOnly) continue;
    const nums = digitsOnly.split(" ").map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (nums.length < 6 || nums.length % 2 !== 0) continue;
    for (let i = 0; i < nums.length - 1; i += 2) {
      const q = nums[i];
      const a = nums[i + 1];
      if (q >= 1 && q <= 100 && a >= 1 && a <= 5) out.push([q, a]);
    }
  }

  // 2차: 부족하면 숫자 스트림 파싱 보강
  if (out.length < 70) {
    const flat = normalized.replace(/[^\d]+/g, " ").replace(/\s+/g, " ").trim();
    const nums = flat ? flat.split(" ").map((v) => Number(v)).filter((n) => Number.isFinite(n)) : [];
    let i = 0;
    let prevQ = 0;
    while (i < nums.length - 1) {
      const q = nums[i];
      const a = nums[i + 1];
      if (Number.isFinite(q) && Number.isFinite(a) && q >= 1 && q <= 100 && a >= 1 && a <= 5) {
        if (q > prevQ || prevQ === 0) {
          out.push([q, a]);
          prevQ = q;
          i += 2;
          continue;
        }
      }
      i += 1;
    }
  }

  return out;
}

function parseAnswerArrayFromPdf(pdfAbsPath) {
  const raw = execFileSync("pdftotext", ["-layout", pdfAbsPath, "-"], { encoding: "utf8" });
  const pairs = parseAnswerPairs(raw);
  const answers = Array(101).fill(null);
  for (const [q, a] of pairs) {
    if (q >= 1 && q <= 100 && a >= 1 && a <= 5) answers[q] = a;
  }
  return answers;
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
      const v = answers[idx];
      const raw = v == null ? "null" : String(v);
      chunk.push(idx < last ? `${raw},` : raw);
    }
    lines.push(`${valueIndent}${chunk.join(" ")}`);
  }
  return `[\n${lines.join("\n")}\n${indent}]`;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const targetQuestionNo = (args.find((a) => a !== "--force") || "").trim();
  if (!fs.existsSync(questionJsonPath)) {
    console.error(`[ERR] missing: ${questionJsonPath}`);
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(questionJsonPath, "utf8"));
  if (!Array.isArray(rows)) {
    console.error("[ERR] question.json must be an array");
    process.exit(1);
  }
  let processed = 0;
  let generated = 0;
  for (const row of rows) {
    const questionNo = String(row?.questionNo || "").trim();
    if (!questionNo) continue;
    if (targetQuestionNo && questionNo !== targetQuestionNo) continue;
    processed += 1;

    const answerPdfRel = normalizePdfPath(row?.answerPdf);
    if (!answerPdfRel) {
      console.warn(`[SKIP] ${questionNo} answerPdf empty`);
      continue;
    }
    const answerPdfAbs = path.join(root, answerPdfRel);
    if (!fs.existsSync(answerPdfAbs)) {
      console.warn(`[SKIP] ${questionNo} missing file: ${answerPdfRel}`);
      continue;
    }

    let answers;
    try {
      answers = parseAnswerArrayFromPdf(answerPdfAbs);
    } catch (err) {
      console.warn(`[SKIP] ${questionNo} parse failed: ${err?.message || err}`);
      continue;
    }

    const known = answers.filter((v, i) => i > 0 && Number.isFinite(v)).length;
    if (known === 0) {
      console.warn(`[SKIP] ${questionNo} zero answers parsed`);
      continue;
    }
    const answersForJson = answers.slice(1, 101);

    const outPath = answerPdfAbs.replace(/\.pdf$/i, ".json");
    if (!force && fs.existsSync(outPath)) {
      console.log(`[SKIP] ${questionNo} exists: ${path.relative(root, outPath)}`);
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const payloadText = [
      "{",
      `  "questionNo": ${JSON.stringify(questionNo)},`,
      `  "questionNm": ${JSON.stringify(String(row?.questionNm || ""))},`,
      `  "sourcePdf": ${JSON.stringify(answerPdfRel)},`,
      `  "generatedAt": ${JSON.stringify(new Date().toISOString())},`,
      `  "count": ${known},`,
      `  "answers": ${formatAnswersArray(answersForJson, 2, 5)}`,
      "}"
    ].join("\n");
    fs.writeFileSync(outPath, `${payloadText}\n`, "utf8");
    generated += 1;
    console.log(`[OK] ${questionNo} -> ${path.relative(root, outPath)} (count=${known})`);
  }

  console.log(`[DONE] processed=${processed} generated=${generated}`);
}

main();
