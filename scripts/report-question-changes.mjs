#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);

let baseRef = "HEAD";
let jsonMode = false;
let limit = 80;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--base" && args[i + 1]) {
    baseRef = args[i + 1];
    i += 1;
  } else if (arg === "--json") {
    jsonMode = true;
  } else if (arg === "--limit" && args[i + 1]) {
    limit = Math.max(1, Number(args[i + 1]) || limit);
    i += 1;
  } else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  }
}

function usage() {
  console.log("Usage: node scripts/report-question-changes.mjs [--base HEAD] [--limit 80] [--json]");
  console.log("Shows changed quiz exams/questions by comparing current working tree with a git base ref.");
}

function git(argsForGit, options = {}) {
  return execFileSync("git", argsForGit, {
    cwd: root,
    encoding: options.encoding || "utf8",
    stdio: ["ignore", "pipe", options.stderr || "ignore"],
  });
}

function splitNul(text) {
  return String(text || "").split("\0").filter(Boolean);
}

function isManagedJson(rel) {
  return /\.json$/i.test(rel) && (rel.startsWith("json/") || rel.startsWith("pdf/"));
}

function changedJsonPaths() {
  const tracked = splitNul(git(["diff", "--name-only", "-z", baseRef, "--", "json", "pdf"])).filter(isManagedJson);
  const untracked = splitNul(git(["ls-files", "--others", "--exclude-standard", "-z", "--", "json", "pdf"])).filter(isManagedJson);
  return [...new Set([...tracked, ...untracked])].sort((a, b) => a.localeCompare(b, "ko"));
}

function readCurrent(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

function readBase(rel) {
  try {
    return git(["show", `${baseRef}:${rel}`], { stderr: "ignore" });
  } catch {
    return null;
  }
}

function parseJson(text, rel, side) {
  if (text == null) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch (err) {
    return { exists: true, value: null, error: `${side} JSON parse failed for ${rel}: ${err?.message || err}` };
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sameValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function stripQuizPrefix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "").replace(/^quiz\//, "");
}

function fileName(value) {
  const normalized = stripQuizPrefix(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function dirnameLabel(value) {
  const normalized = stripQuizPrefix(value);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function rowKey(row, idx = 0) {
  return stripQuizPrefix(row?.questionPdf || row?.answerPdf || row?.path || "") || String(row?.questionNo || row?.answerSourceId || row?.sourceId || idx + 1);
}

function rowLabel(row, fallback = "") {
  const no = row?.questionNo ? `#${row.questionNo} ` : "";
  const name = row?.questionNm || fileName(row?.questionPdf) || fileName(row?.answerPdf) || fallback || "unknown";
  return `${no}${name}`;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  return null;
}

function answerEntries(owner) {
  const answers = Array.isArray(owner?.answers) ? owner.answers : null;
  if (!answers) return null;
  const entries = new Map();
  const padded = answers.length > 0 && answers[0] == null;
  const startIndex = padded ? 1 : 0;
  const printedMap = Array.isArray(owner?.printedAnswerNoMap) ? owner.printedAnswerNoMap : null;
  const startNo = Number(owner?.answerStartNo || owner?.questionStartNo || 1) || 1;
  for (let i = startIndex; i < answers.length; i += 1) {
    const sequence = padded ? i : i + 1;
    const fallbackNo = startNo + sequence - 1;
    const printedNo = Number(printedMap?.[sequence] || fallbackNo) || fallbackNo;
    entries.set(String(printedNo), answers[i]);
  }
  return entries;
}

function compareAnswerMaps(baseOwner, currentOwner) {
  const before = answerEntries(baseOwner) || new Map();
  const after = answerEntries(currentOwner) || new Map();
  const questionNos = [...new Set([...before.keys(), ...after.keys()])]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const changes = [];
  for (const q of questionNos) {
    const key = String(q);
    if (!sameValue(before.get(key), after.get(key))) {
      changes.push({ q, before: before.get(key), after: after.get(key) });
    }
  }
  return changes;
}

function summarizeFields(before = {}, after = {}, skip = new Set()) {
  const fields = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((field) => !skip.has(field))
    .sort();
  const changed = [];
  for (const field of fields) {
    if (!sameValue(before?.[field], after?.[field])) changed.push(field);
  }
  return changed;
}

function compareRowPayload(beforePayload, afterPayload, rel) {
  const beforeRows = rowsFromPayload(beforePayload) || [];
  const afterRows = rowsFromPayload(afterPayload) || [];
  const beforeByKey = new Map(beforeRows.map((row, idx) => [rowKey(row, idx), row]));
  const afterByKey = new Map(afterRows.map((row, idx) => [rowKey(row, idx), row]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort((a, b) => a.localeCompare(b, "ko"));
  const rows = [];
  for (const key of keys) {
    const before = beforeByKey.get(key);
    const after = afterByKey.get(key);
    const label = rowLabel(after || before, fileName(key));
    if (!before) {
      rows.push({ kind: "exam", status: "added", label, key });
      continue;
    }
    if (!after) {
      rows.push({ kind: "exam", status: "removed", label, key });
      continue;
    }
    const answerChanges = compareAnswerMaps(before, after);
    const fieldChanges = summarizeFields(before, after, new Set(["answers"]));
    if (answerChanges.length) {
      rows.push({ kind: "answers", status: "modified", label, key, changes: answerChanges });
    }
    if (fieldChanges.length) {
      rows.push({ kind: "exam", status: "modified", label, key, fields: fieldChanges });
    }
  }
  if (!rows.length && !sameValue(beforePayload, afterPayload)) {
    rows.push({ kind: "json", status: "modified", label: fileName(rel) || rel, key: rel });
  }
  return rows;
}

function addQuestionChange(bucket, q, label) {
  const key = String(q);
  if (!bucket.has(key)) bucket.set(key, new Set());
  bucket.get(key).add(label);
}

function compareObjectMapField(before, after, field, bucket, label = field) {
  const a = before?.[field] && typeof before[field] === "object" ? before[field] : {};
  const b = after?.[field] && typeof after[field] === "object" ? after[field] : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => Number(x) - Number(y));
  for (const key of keys) {
    if (!sameValue(a[key], b[key])) addQuestionChange(bucket, key, label);
  }
}

function compareArrayQuestionField(before, after, field, bucket, label = field) {
  const a = Array.isArray(before?.[field]) ? before[field] : [];
  const b = Array.isArray(after?.[field]) ? after[field] : [];
  const max = Math.max(a.length, b.length);
  for (let q = 1; q < max; q += 1) {
    if (!sameValue(a[q], b[q])) addQuestionChange(bucket, q, label);
  }
}

function summarizeChoiceField(before, after, field, bucket, label = field) {
  const a = before?.[field] && typeof before[field] === "object" ? before[field] : {};
  const b = after?.[field] && typeof after[field] === "object" ? after[field] : {};
  const questionKeys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => Number(x) - Number(y));
  for (const q of questionKeys) {
    if (sameValue(a[q], b[q])) continue;
    const beforeChoices = a[q] && typeof a[q] === "object" ? a[q] : {};
    const afterChoices = b[q] && typeof b[q] === "object" ? b[q] : {};
    const choiceKeys = [...new Set([...Object.keys(beforeChoices), ...Object.keys(afterChoices)])]
      .filter((key) => !Number.isNaN(Number(key)))
      .sort((x, y) => Number(x) - Number(y));
    const changedChoices = choiceKeys.filter((choice) => !sameValue(beforeChoices[choice], afterChoices[choice]));
    addQuestionChange(bucket, q, changedChoices.length ? `${label} ${changedChoices.join(",")}` : label);
  }
}

function compareAnchorPayload(before, after, rel) {
  const questionChanges = new Map();
  compareObjectMapField(before, after, "questionLabelMap", questionChanges, "문제 위치");
  compareObjectMapField(before, after, "questionSegments", questionChanges, "문제 영역");
  compareArrayQuestionField(before, after, "questionPageMap", questionChanges, "문제 페이지");
  compareArrayQuestionField(before, after, "questionTopRatioMap", questionChanges, "문제 상단");
  compareArrayQuestionField(before, after, "printedQuestionNoMap", questionChanges, "인쇄 번호");
  summarizeChoiceField(before, after, "choiceAnchorMap", questionChanges, "선택지 위치");
  summarizeChoiceField(before, after, "choiceClickAreaMap", questionChanges, "선택지 클릭영역");

  const skip = new Set([
    "questionLabelMap",
    "questionSegments",
    "questionPageMap",
    "questionTopRatioMap",
    "printedQuestionNoMap",
    "choiceAnchorMap",
    "choiceClickAreaMap",
    "anchors",
  ]);
  const metaFields = summarizeFields(before || {}, after || {}, skip);
  const anchorArrayChanged = !sameValue(before?.anchors, after?.anchors);
  const rows = [];
  const label = after?.questionPdf ? fileName(after.questionPdf) : fileName(rel);
  if (questionChanges.size) {
    rows.push({
      kind: "anchor",
      status: "modified",
      label,
      key: rel,
      questions: [...questionChanges.entries()]
        .map(([q, labels]) => ({ q: Number(q), changes: [...labels].sort() }))
        .sort((a, b) => a.q - b.q),
    });
  }
  if (metaFields.length || anchorArrayChanged) {
    rows.push({
      kind: "anchor-meta",
      status: "modified",
      label,
      key: rel,
      fields: [...metaFields, ...(anchorArrayChanged ? ["anchors"] : [])],
    });
  }
  return rows;
}

function compareStandaloneAnswers(before, after, rel) {
  const changes = compareAnswerMaps(before || {}, after || {});
  return changes.length ? [{
    kind: "answers",
    status: "modified",
    label: after?.questionNm || before?.questionNm || fileName(rel),
    key: rel,
    changes,
  }] : [];
}

function compareFile(rel) {
  const beforeText = readBase(rel);
  const afterText = readCurrent(rel);
  const beforeParsed = parseJson(beforeText, rel, baseRef);
  const afterParsed = parseJson(afterText, rel, "working tree");
  const parseErrors = [beforeParsed.error, afterParsed.error].filter(Boolean);
  if (parseErrors.length) return { rel, rows: parseErrors.map((error) => ({ kind: "error", status: "error", label: error, key: rel })) };

  const before = beforeParsed.value;
  const after = afterParsed.value;
  if (!beforeParsed.exists && afterParsed.exists) {
    return { rel, rows: [{ kind: "file", status: "added", label: rel, key: rel }] };
  }
  if (beforeParsed.exists && !afterParsed.exists) {
    return { rel, rows: [{ kind: "file", status: "removed", label: rel, key: rel }] };
  }
  if (sameValue(before, after)) return { rel, rows: [] };

  if (/_anchor\.json$/i.test(rel) || before?.kind === "question-anchor-map" || after?.kind === "question-anchor-map") {
    return { rel, rows: compareAnchorPayload(before, after, rel) };
  }
  if (Array.isArray(before) || Array.isArray(after) || Array.isArray(before?.items) || Array.isArray(after?.items)) {
    return { rel, rows: compareRowPayload(before, after, rel) };
  }
  if (Array.isArray(before?.answers) || Array.isArray(after?.answers)) {
    return { rel, rows: compareStandaloneAnswers(before, after, rel) };
  }
  return { rel, rows: [{ kind: "json", status: "modified", label: rel, key: rel }] };
}

function formatQuestionList(items, formatter) {
  const shown = items.slice(0, limit).map(formatter);
  const more = items.length > limit ? [`  ... ${items.length - limit}개 더 있음`] : [];
  return [...shown, ...more].join("\n");
}

function formatRow(row) {
  const prefix = row.status === "added" ? "추가" : row.status === "removed" ? "삭제" : row.status === "error" ? "오류" : "수정";
  if (row.kind === "answers") {
    return [
      `- ${prefix} 정답: ${row.label} (${row.changes.length}문항)`,
      formatQuestionList(row.changes, (change) => `  · ${change.q}번: ${change.before ?? "-"} -> ${change.after ?? "-"}`),
    ].join("\n");
  }
  if (row.kind === "anchor") {
    return [
      `- ${prefix} 위치맵: ${row.label} (${row.questions.length}문항)`,
      formatQuestionList(row.questions, (item) => `  · ${item.q}번: ${item.changes.join(", ")}`),
    ].join("\n");
  }
  if (row.kind === "exam" && row.fields?.length) {
    return `- ${prefix} 회차: ${row.label} (${row.fields.join(", ")})`;
  }
  if (row.kind === "anchor-meta" && row.fields?.length) {
    return `- ${prefix} 위치맵 메타: ${row.label} (${row.fields.join(", ")})`;
  }
  return `- ${prefix}: ${row.label}`;
}

function main() {
  const paths = changedJsonPaths();
  const reports = paths.map(compareFile).filter((report) => report.rows.length);
  const totalRows = reports.reduce((sum, report) => sum + report.rows.length, 0);
  const answerQuestionCount = reports.flatMap((report) => report.rows)
    .filter((row) => row.kind === "answers")
    .reduce((sum, row) => sum + row.changes.length, 0);
  const anchorQuestionCount = reports.flatMap((report) => report.rows)
    .filter((row) => row.kind === "anchor")
    .reduce((sum, row) => sum + row.questions.length, 0);

  const result = {
    ok: true,
    base: baseRef,
    changedJsonFiles: paths.length,
    reportedFiles: reports.length,
    reportedItems: totalRows,
    answerQuestionCount,
    anchorQuestionCount,
    reports,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`기준: ${baseRef}`);
  if (!reports.length) {
    console.log("문항 관련 JSON 변경이 없습니다.");
    return;
  }
  console.log(`변경 JSON 파일: ${reports.length}개`);
  if (answerQuestionCount || anchorQuestionCount) {
    console.log(`문항 변경: 정답 ${answerQuestionCount}개, 위치맵 ${anchorQuestionCount}개`);
  }
  for (const report of reports) {
    console.log("");
    console.log(`[${report.rel}]`);
    for (const row of report.rows) console.log(formatRow(row));
  }
}

main();
