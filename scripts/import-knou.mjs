#!/usr/bin/env node
/* SOFTM-KNOU 시작: 방통대 문제/정답 파일 import 및 knou_ manifest 생성 스크립트 추가 - 2026-05-29 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const jsonDir = path.join(root, "json");
const pdfRoot = path.join(root, "pdf", "방통대");
const multiAnswerMap = {
  A: [1, 2],
  B: [1, 3],
  C: [1, 4],
  D: [2, 3],
  E: [2, 4],
  F: [3, 4],
  G: [1, 2, 3],
  H: [1, 2, 4],
  I: [1, 3, 4],
  J: [2, 3, 4],
  K: [1, 2, 3, 4],
};

function usage(){
  console.log("Usage:");
  console.log("  node scripts/import-knou.mjs --answers-dir <dir> [--dry-run]");
  console.log("  node scripts/import-knou.mjs --answer <file> [--year yyyy] [--semester 1|2] [--exam-type final|midterm|seasonal] [--scope all]");
  console.log("  node scripts/import-knou.mjs --questions-dir <dir> [--answer-source-id <sourceId>] [--dry-run]");
  console.log("  node scripts/import-knou.mjs --question <file> [--course <교과목명>] [--department <학과명>] --answer-source-id <sourceId>");
}

function parseArgs(argv){
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++){
    const key = argv[i];
    if (key === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    out[name] = value;
  }
  return out;
}

function readJson(fileName, fallback){
  const filePath = path.join(jsonDir, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/* SOFTM-FORMAT 시작: 방통대 정답 source의 answers 배열도 10개 단위 줄바꿈으로 저장 - 2026-05-29 */
function formatAnswersArray(values, indent = 0, perLine = 10){
  const lines = ["["];
  if (values.length){
    const valueIndent = " ".repeat(indent + 2);
    const last = values.length - 1;
    for (let start = 0; start < values.length; start += perLine){
      const chunk = [];
      for (let idx = start; idx < Math.min(start + perLine, values.length); idx++){
        const raw = JSON.stringify(values[idx]) ?? "null";
        chunk.push(idx < last ? `${raw},` : raw);
      }
      lines.push(`${valueIndent}${chunk.join(" ")}`);
    }
  }
  lines.push(`${" ".repeat(indent)}]`);
  return lines.join("\n");
}

function formatJsonValue(value, indent = 0, keyName = ""){
  if (keyName === "answers" && Array.isArray(value)) return formatAnswersArray(value, indent);
  if (Array.isArray(value)){
    if (!value.length) return "[]";
    const lines = ["["];
    value.forEach((child, idx) => {
      const comma = idx < value.length - 1 ? "," : "";
      lines.push(`${" ".repeat(indent + 2)}${formatJsonValue(child, indent + 2)}${comma}`);
    });
    lines.push(`${" ".repeat(indent)}]`);
    return lines.join("\n");
  }
  if (value && typeof value === "object"){
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    if (!entries.length) return "{}";
    const lines = ["{"];
    entries.forEach(([key, child], idx) => {
      const comma = idx < entries.length - 1 ? "," : "";
      lines.push(`${" ".repeat(indent + 2)}${JSON.stringify(key)}: ${formatJsonValue(child, indent + 2, key)}${comma}`);
    });
    lines.push(`${" ".repeat(indent)}}`);
    return lines.join("\n");
  }
  return JSON.stringify(value) ?? "null";
}
/* SOFTM-FORMAT 끝 */

function writeJson(fileName, data, dryRun){
  const filePath = path.join(jsonDir, fileName);
  if (dryRun) {
    console.log(`[DRY] write ${path.relative(root, filePath)}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${formatJsonValue(data)}\n`, "utf8");
}

function walkFiles(dir, exts){
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function sanitizeFilePart(value){
  return String(value || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeIdPart(value){
  return sanitizeFilePart(value)
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function normalizeSemester(value){
  const raw = String(value || "").trim();
  if (raw === "1" || /1\s*학기/.test(raw)) return "1";
  if (raw === "2" || /2\s*학기/.test(raw)) return "2";
  return "";
}

function normalizeExamType(value){
  const raw = String(value || "").toLowerCase();
  if (/mid|중간/.test(raw)) return "midterm";
  if (/season|계절/.test(raw)) return "seasonal";
  if (/substitute|attendance|출석수업대체|대체/.test(raw)) return "substitute";
  if (/final|기말/.test(raw)) return "final";
  return "final";
}

function readPdfInfo(filePath){
  if (path.extname(filePath).toLowerCase() !== ".pdf") return {};
  try{
    const raw = execFileSync("pdfinfo", [filePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const created = raw.match(/CreationDate:\s+(.+)/i)?.[1] || "";
    const pages = Number(raw.match(/Pages:\s+(\d+)/i)?.[1] || "");
    const year = (created.match(/\b(20\d{2})\b/) || [])[1] || "";
    const monthName = (created.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i) || [])[1] || "";
    const monthMap = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const month = monthName ? monthMap[monthName.toLowerCase()] : 0;
    return { year, month, pages: Number.isFinite(pages) ? pages : 0 };
  }catch(_){
    return {};
  }
}

function readPdfText(filePath){
  if (path.extname(filePath).toLowerCase() !== ".pdf") return "";
  try{
    return execFileSync("pdftotext", ["-layout", filePath, "-"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  }catch(_){
    return "";
  }
}

function inferMeta(filePath, overrides = {}){
  const name = path.basename(filePath).normalize("NFC");
  const pdfText = readPdfText(filePath);
  const pdfInfo = readPdfInfo(filePath);
  const year = overrides.year || (name.match(/(20\d{2})/) || [])[1] || (pdfText.match(/(20\d{2})\s*학년도/) || [])[1] || pdfInfo.year || "";
  let semester = normalizeSemester(overrides.semester);
  if (!semester) {
    const m = `${name} ${pdfText}`.match(/(?:20\d{2})\s*[-. ]\s*([12])|([12])\s*학기/);
    semester = normalizeSemester(m && (m[1] || m[2]));
  }
  if (!semester && pdfInfo.month) semester = pdfInfo.month >= 9 ? "2" : "1";
  const examType = normalizeExamType(overrides.examType || `${name} ${pdfText}`);
  let scope = overrides.scope || "all";
  if (/1\s*2\s*학년|1,?\s*2\s*학년/.test(name)) scope = "grade1-2";
  else if (/3\s*4\s*학년|3,?\s*4\s*학년/.test(name)) scope = "grade3-4";
  else if (/대면/.test(name)) scope = "face";
  else if (/전학년|all/i.test(name)) scope = "all";
  return { year, semester, examType, scope };
}

function inferQuestionInfo(filePath){
  const name = path.basename(filePath, path.extname(filePath)).normalize("NFC");
  const pdfText = readPdfText(filePath);
  const pdfInfo = readPdfInfo(filePath);
  const sourceCode = (name.match(/^(\d{2,4})-/) || [])[1] || "";
  const grade = Number((name.match(/([1-4])\s*학년/) || pdfText.match(/([1-4])\s*학년/) || [])[1] || "");
  const period = Number((name.match(/([1-9])\s*교시/) || pdfText.match(/([1-9])\s*교시/) || [])[1] || "");
  const subjectOrder = Number((name.match(/([1-9])\s*과목/) || pdfText.match(/([1-9])\s*과목/) || [])[1] || "");
  const courseFromName = (() => {
    const withoutCode = name.replace(/^\d{2,4}-/, "");
    const m = withoutCode.match(/^(.+?)-[1-4]\s*학년/);
    return m ? sanitizeFilePart(m[1]) : "";
  })();
  const courseFromText = sanitizeFilePart((pdfText.match(/(?:제\s*)?\d+\s*과목\s+([가-힣A-Za-z0-9_ -]{2,40})/) || [])[1] || "");
  const range = (pdfText.match(/(\d{1,3})\s*[～~\-]\s*(\d{1,3})\s*번/) || []);
  const startNo = Number(range[1] || "");
  const endNo = Number(range[2] || "");
  return {
    sourceCode,
    grade: Number.isFinite(grade) ? grade : "",
    period: Number.isFinite(period) ? period : "",
    subjectOrder: Number.isFinite(subjectOrder) ? subjectOrder : "",
    course: courseFromName || courseFromText,
    pageCount: pdfInfo.pages || "",
    questionStartNo: Number.isFinite(startNo) ? startNo : "",
    questionEndNo: Number.isFinite(endNo) ? endNo : "",
  };
}

function makeAnswerSourceId(meta){
  return `knou_${meta.year}_${meta.semester}_${meta.examType}_${sanitizeIdPart(meta.scope || "all")}`;
}

function makeAnswerTargetPath(filePath, meta){
  const ext = path.extname(filePath).toLowerCase();
  const fileName = `${makeAnswerSourceId(meta)}_정답표${ext}`;
  return path.join(pdfRoot, "정답", String(meta.year || "unknown"), fileName);
}

function makeQuestionTargetPath(filePath, meta, department, course, info = {}){
  const ext = path.extname(filePath).toLowerCase() || ".pdf";
  const sourceCode = info.sourceCode ? `_${sanitizeIdPart(info.sourceCode)}` : "";
  const period = info.period ? `_${info.period}교시` : "";
  const subjectOrder = info.subjectOrder ? `_${info.subjectOrder}과목` : "";
  const fileName = `knou_${meta.year}_${meta.semester}_${meta.examType}_${sanitizeFilePart(course)}${sourceCode}${period}${subjectOrder}_문제${ext}`;
  return path.join(pdfRoot, "문제", String(meta.year || "unknown"), `${meta.semester}_${meta.examType}`, sanitizeFilePart(department), fileName);
}

function toManifestPath(absPath){
  return `quiz/${path.relative(root, absPath).split(path.sep).join("/")}`;
}

function copyIfNeeded(src, dest, dryRun){
  if (path.resolve(src) === path.resolve(dest)) return dest;
  if (dryRun) {
    console.log(`[DRY] copy ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

function decodeHtmlEntities(value){
  return String(value || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanCell(value){
  return decodeHtmlEntities(value)
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAnswerSequence(raw){
  const out = [];
  const compact = String(raw || "").toUpperCase().replace(/[^1-5A-K]/g, "");
  for (const ch of compact){
    if (/^[1-5]$/.test(ch)) out.push(Number(ch));
    else if (multiAnswerMap[ch]) out.push(multiAnswerMap[ch]);
  }
  return out;
}

function parseRowsFromCells(rows){
  const subjects = [];
  const seen = new Map();
  for (const cells of rows){
    if (!Array.isArray(cells) || cells.length < 3) continue;
    const grade = cleanCell(cells[0]);
    if (!/^[1-4]$/.test(grade)) continue;
    const subject = cleanCell(cells[1]);
    if (!subject || /교과목명|학년/.test(subject)) continue;
    const answerCells = cells.slice(2).map(cleanCell).filter(Boolean);
    const answers = parseAnswerSequence(answerCells.join(""));
    if (answers.length < 5) continue;
    const key = `${subject}::${grade}`;
    seen.set(key, {
      subject,
      grade: Number(grade),
      questionCount: answers.length,
      answers,
    });
  }
  subjects.push(...seen.values());
  subjects.sort((a, b) => a.grade - b.grade || a.subject.localeCompare(b.subject, "ko"));
  return subjects;
}

function parseRowsFromText(text){
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)){
    const trimmed = line.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(" ");
    if (!/^[1-4]$/.test(tokens[0] || "")) continue;
    let idx = tokens.length - 1;
    const answerTokens = [];
    while (idx >= 2 && /^[1-5A-K]+$/i.test(tokens[idx])) {
      answerTokens.unshift(tokens[idx]);
      idx -= 1;
    }
    if (answerTokens.length === 0) continue;
    const subject = tokens.slice(1, idx + 1).join(" ").trim();
    if (!subject || /교과목명|학년/.test(subject)) continue;
    rows.push([tokens[0], subject, ...answerTokens]);
  }
  return parseRowsFromCells(rows);
}

function parseRowsFromHwp(filePath){
  const html = execFileSync("hwp5html", ["--html", filePath], { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 });
  const rows = [];
  const trMatches = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches){
    const cells = [];
    const tdMatches = tr.match(/<td\b[\s\S]*?<\/td>/gi) || [];
    for (const td of tdMatches){
      const text = td
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "");
      cells.push(cleanCell(text));
    }
    if (cells.length) rows.push(cells);
  }
  return parseRowsFromCells(rows);
}

function parseRowsFromPdf(filePath){
  const text = execFileSync("pdftotext", ["-layout", filePath, "-"], { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 });
  return parseRowsFromText(text);
}

function parseAnswerSource(filePath, meta, targetPath){
  const ext = path.extname(filePath).toLowerCase();
  const subjects = ext === ".hwp" ? parseRowsFromHwp(filePath) : parseRowsFromPdf(filePath);
  return {
    sourceId: makeAnswerSourceId(meta),
    year: Number(meta.year) || meta.year,
    semester: meta.semester,
    examType: meta.examType,
    scope: meta.scope,
    sourceFile: toManifestPath(targetPath),
    sourceFormat: ext.replace(".", ""),
    subjects,
  };
}

function upsertByKey(list, keyName, row){
  const idx = list.findIndex((item) => String(item?.[keyName] || "") === String(row[keyName]));
  if (idx >= 0) list[idx] = row;
  else list.push(row);
}

function ensureGroup(groups, gNo, gNm){
  if (groups.some((row) => String(row.gNo) === String(gNo))) return;
  groups.push({ gNo, gNm, seq: groups.length + 1 });
}

function ensureCourseMapping(courseMap, course, department){
  const courses = courseMap.courses || {};
  courseMap.courses = courses;
  if (!courses[course]) {
    const dep = department || courseMap.defaultDepartment || "방통대 미분류";
    courses[course] = {
      department: dep,
      gNo: dep === "방통대 미분류" ? "knou_unmapped" : `knou_${sanitizeIdPart(dep)}`,
      catNo: `knou_${sanitizeIdPart(course)}`,
    };
  }
  return courses[course];
}

function importAnswerFile(filePath, options, state){
  const meta = inferMeta(filePath, options);
  if (!meta.year || !meta.semester) {
    console.warn(`[SKIP] meta parse failed: ${filePath}`);
    return;
  }
  const targetPath = makeAnswerTargetPath(filePath, meta);
  copyIfNeeded(filePath, targetPath, options.dryRun);
  const source = parseAnswerSource(filePath, meta, targetPath);
  upsertByKey(state.answerSources, "sourceId", source);
  console.log(`[OK] answer ${source.sourceId} subjects=${source.subjects.length}`);
}

function importQuestionFile(filePath, options, state){
  const info = inferQuestionInfo(filePath);
  const course = sanitizeFilePart(options.course || info.course || "");
  if (!course) throw new Error("--question requires --course when filename/text cannot infer course");
  const meta = inferMeta(filePath, options);
  if (!meta.year || !meta.semester) throw new Error("--question requires year/semester metadata");

  const mapping = ensureCourseMapping(state.courseMap, course, options.department || "");
  const department = mapping.department || state.courseMap.defaultDepartment || "방통대 미분류";
  const gNo = mapping.gNo || "knou_unmapped";
  const catNo = mapping.catNo || `knou_${sanitizeIdPart(course)}`;
  ensureGroup(state.groups, gNo, department);
  upsertByKey(state.categories, "catNo", {
    gNo,
    gNm: department,
    catNm: course,
    catNo,
    seq: state.categories.length + 1,
  });

  const targetPath = makeQuestionTargetPath(filePath, meta, department, course, info);
  copyIfNeeded(filePath, targetPath, options.dryRun);
  const answerSourceId = options.answerSourceId || makeAnswerSourceId(meta);
  const sourceSuffix = info.sourceCode ? `_${sanitizeIdPart(info.sourceCode)}` : "";
  const questionNo = `knou_${meta.year}_${meta.semester}_${meta.examType}_${sanitizeIdPart(course)}${sourceSuffix}`;
  const examTypeLabel = meta.examType === "final" ? "기말시험" : (meta.examType === "substitute" ? "출석수업대체시험" : meta.examType);
  const periodLabel = info.period ? ` ${info.period}교시` : "";
  const subjectOrderLabel = info.subjectOrder ? ` ${info.subjectOrder}과목` : "";
  const inferredQuestionCount = info.questionStartNo && info.questionEndNo ? (Number(info.questionEndNo) - Number(info.questionStartNo) + 1) : 100; // SOFTM-KNOU: 16~30번처럼 시작 번호가 1이 아닌 문제지 문항 수 계산 - 2026-05-29
  upsertByKey(state.questions, "questionNo", {
    dataset: "knou",
    gNo,
    gNm: department,
    catNm: course,
    catNo,
    questionNm: `${meta.year}학년도 ${meta.semester}학기 ${examTypeLabel}${periodLabel}${subjectOrderLabel} ${course}`,
    questionNo,
    questionPdf: toManifestPath(targetPath),
    answerPdf: "",
    answerSourceId,
    answerSubject: course,
    grade: options.grade ? Number(options.grade) : (info.grade || undefined),
    questionCount: options.questionCount ? Number(options.questionCount) : inferredQuestionCount,
    choiceCount: 4,
    sourceCode: info.sourceCode || undefined,
    period: info.period || undefined,
    subjectOrder: info.subjectOrder || undefined,
    questionStartNo: info.questionStartNo || undefined,
    questionEndNo: info.questionEndNo || undefined,
    pageCount: info.pageCount || undefined,
    year: Number(meta.year) || meta.year,
    semester: meta.semester,
    examType: meta.examType,
    seq: state.questions.length + 1,
  });
  console.log(`[OK] question ${questionNo}`);
}

function main(){
  const options = parseArgs(process.argv.slice(2));
  if (!options.answersDir && !options.answer && !options.questionsDir && !options.question) {
    usage();
    process.exit(1);
  }

  const state = {
    groups: readJson("knou_group.json", []),
    categories: readJson("knou_category.json", []),
    questions: readJson("knou_question.json", []),
    courseMap: readJson("knou_course_map.json", { version: 1, defaultDepartment: "방통대 미분류", courses: {} }),
    answerSources: readJson("knou_answer_sources.json", []),
  };

  if (options.answersDir) {
    const files = walkFiles(path.resolve(options.answersDir), [".pdf", ".hwp"]);
    for (const file of files) importAnswerFile(file, options, state);
  }
  if (options.answer) importAnswerFile(path.resolve(options.answer), options, state);
  if (options.questionsDir) {
    const files = walkFiles(path.resolve(options.questionsDir), [".pdf"]);
    for (const file of files) importQuestionFile(file, options, state);
  }
  if (options.question) importQuestionFile(path.resolve(options.question), options, state);

  state.groups.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  state.categories.sort((a, b) => String(a.gNm || "").localeCompare(String(b.gNm || ""), "ko") || String(a.catNm || "").localeCompare(String(b.catNm || ""), "ko"));
  state.categories.forEach((row, idx) => { row.seq = idx + 1; });
  state.questions.sort((a, b) => String(a.catNm || "").localeCompare(String(b.catNm || ""), "ko") || String(b.year || "").localeCompare(String(a.year || "")) || Number(a.seq || 0) - Number(b.seq || 0));
  state.questions.forEach((row, idx) => { row.seq = idx + 1; });
  state.answerSources.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));

  writeJson("knou_group.json", state.groups, options.dryRun);
  writeJson("knou_category.json", state.categories, options.dryRun);
  writeJson("knou_question.json", state.questions, options.dryRun);
  writeJson("knou_course_map.json", state.courseMap, options.dryRun);
  writeJson("knou_answer_sources.json", state.answerSources, options.dryRun);
}

main();
/* SOFTM-KNOU 끝 */
