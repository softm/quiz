#!/usr/bin/env node
/* SOFTM-ADMIN 시작: 로컬 관리자 서버 및 파일 관리 API 추가 - 2026-05-29 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || getArg("--port") || 8787);
const maxUploadBytes = 250 * 1024 * 1024;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".hwp": "application/octet-stream",
  ".hwpx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

function getArg(name){
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : "";
}

function adminCorsHeaders(){
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function sendJson(res, status, data){
  const body = `${JSON.stringify(data, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...adminCorsHeaders(),
  });
  res.end(body);
}

function sendText(res, status, text){
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...adminCorsHeaders() });
  res.end(text);
}

function sendHtml(res, status, html){
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...adminCorsHeaders(),
  });
  res.end(html);
}

function normalizeRelPath(value){
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .trim();
}

function resolveWorkspacePath(value){
  const rel = normalizeRelPath(value);
  const abs = path.resolve(root, rel || ".");
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error("workspace 밖 경로는 사용할 수 없습니다.");
  }
  return abs;
}

function buildUnicodeRelVariants(value){
  const rel = normalizeRelPath(value);
  const parts = rel.split("/").filter(Boolean);
  const variants = [
    rel,
    rel.normalize("NFC"),
    rel.normalize("NFD"),
    parts.map((part) => part.normalize("NFC")).join("/"),
    parts.map((part) => part.normalize("NFD")).join("/"),
  ];
  return [...new Set(variants.filter(Boolean))];
}

async function resolveExistingWorkspacePath(value){
  const rel = normalizeRelPath(value);
  for (const variant of buildUnicodeRelVariants(rel)) {
    const abs = resolveWorkspacePath(variant);
    try{
      await fsp.access(abs);
      return abs;
    }catch(_){
      // Try the next unicode-normalized candidate.
    }
  }
  return resolveWorkspacePath(rel);
}

function assertManagedPath(value){
  const rel = normalizeRelPath(value);
  const allowed = rel === "pdf" || rel === "json" || rel.startsWith("pdf/") || rel.startsWith("json/");
  if (!rel || !allowed) {
    throw new Error("관리 가능 경로는 pdf 또는 json 아래로 제한됩니다.");
  }
  return resolveWorkspacePath(rel);
}

async function assertExistingManagedPath(value){
  const rel = normalizeRelPath(value);
  const allowed = rel === "pdf" || rel === "json" || rel.startsWith("pdf/") || rel.startsWith("json/");
  if (!rel || !allowed) {
    throw new Error("관리 가능 경로는 pdf 또는 json 아래로 제한됩니다.");
  }
  return await resolveExistingWorkspacePath(rel);
}

function toRel(abs){
  return path.relative(root, abs).split(path.sep).join("/") || ".";
}

function readJsonFile(rel, fallback){
  try{
    return JSON.parse(fs.readFileSync(path.join(root, "json", rel), "utf8"));
  }catch(_){
    return fallback;
  }
}

async function writeJsonFile(rel, data){
  const target = path.join(root, "json", rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
// SOFTM-위치맵: 문제·문항 위치맵 생성 후 manifest 보조 필드를 저장하기 위한 JSON 쓰기 헬퍼 추가 - 2026-05-30

/* SOFTM-ADMIN 시작: 카테고리/문제 관리 테이블용 카탈로그 집계 API 추가 - 2026-05-29 */
const pdfDiagnosticCache = new Map();

function stripManifestPrefix(value){
  if (Array.isArray(value)) value = value[0] || "";
  const raw = normalizeRelPath(value);
  return raw.replace(/^quiz\//, "");
}

async function readSmallJsonRequest(req, maxBytes = 2 * 1024 * 1024){
  const chunks = [];
  let total = 0;
  for await (const chunk of req){
    total += chunk.length;
    if (total > maxBytes) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function normalizeAnchorMapRelPath(value){
  const rel = stripManifestPrefix(value);
  if (!rel || !rel.startsWith("pdf/") || !/_anchor\.json$/i.test(rel)) {
    throw new Error("위치맵 파일은 pdf 아래의 _anchor.json만 저장할 수 있습니다.");
  }
  return rel;
}

function parseAnchorQuestionList(value){
  const out = new Set();
  for (const part of String(value || "").split(",")){
    const q = Math.trunc(Number(part));
    if (Number.isInteger(q) && q > 0 && q <= 999) out.add(q);
  }
  return [...out].sort((a, b) => a - b);
}

function pickAnchorQuestionMap(map, questions){
  if (!map || typeof map !== "object" || !Array.isArray(questions) || !questions.length) return null;
  const out = {};
  for (const q of questions){
    const key = String(q);
    if (Object.prototype.hasOwnProperty.call(map, key)) out[key] = map[key];
  }
  return Object.keys(out).length ? out : null;
}

function buildAnchorDataResponse(anchorData, questions = []){
  const includeDetails = Array.isArray(questions) && questions.length > 0;
  const base = {
    version: anchorData.version,
    kind: anchorData.kind,
    questionNo: anchorData.questionNo,
    questionPdf: anchorData.questionPdf,
    pageCount: anchorData.pageCount,
    questionCount: anchorData.questionCount,
    choiceCount: anchorData.choiceCount,
    questionStartNo: anchorData.questionStartNo,
    questionEndNo: anchorData.questionEndNo,
    printedQuestionNoMap: Array.isArray(anchorData.printedQuestionNoMap) ? anchorData.printedQuestionNoMap : null,
    questionLabelMap: anchorData.questionLabelMap && typeof anchorData.questionLabelMap === "object" ? anchorData.questionLabelMap : null,
    questionColumnBoundsMap: anchorData.questionColumnBoundsMap && typeof anchorData.questionColumnBoundsMap === "object" ? anchorData.questionColumnBoundsMap : null,
    questionPageMap: Array.isArray(anchorData.questionPageMap) ? anchorData.questionPageMap : null,
    questionTopRatioMap: Array.isArray(anchorData.questionTopRatioMap) ? anchorData.questionTopRatioMap : null,
    anchors: Array.isArray(anchorData.anchors) ? anchorData.anchors : null,
    rawAnchorCount: anchorData.rawAnchorCount,
    sourceStats: anchorData.sourceStats || null,
    confidence: anchorData.confidence,
    warnings: anchorData.warnings || [],
    generatedAt: anchorData.generatedAt || "",
    manualEditedAt: anchorData.manualEditedAt || "",
    _manualBase: anchorData._manualBase && typeof anchorData._manualBase === "object" ? anchorData._manualBase : null,
    partial: true,
  };
  if (includeDetails) {
    base.detailQuestions = questions;
    base.questionSegments = pickAnchorQuestionMap(anchorData.questionSegments, questions);
    base.choiceAnchorMap = pickAnchorQuestionMap(anchorData.choiceAnchorMap, questions);
    base.choiceClickAreaMap = pickAnchorQuestionMap(anchorData.choiceClickAreaMap, questions);
  }
  return base;
}

async function handleAnchorData(req, res, url){
  try{
    const rel = normalizeAnchorMapRelPath(url.searchParams.get("path") || url.searchParams.get("anchorMap") || "");
    const abs = await assertExistingManagedPath(rel);
    const anchorData = JSON.parse(await fsp.readFile(abs, "utf8"));
    if (anchorData.kind !== "question-anchor-map") throw new Error("question-anchor-map 형식이 아닙니다.");
    const questions = parseAnchorQuestionList(url.searchParams.get("questions") || url.searchParams.get("q") || "");
    sendJson(res, 200, {
      ok: true,
      anchorMap: rel,
      anchorData: buildAnchorDataResponse(anchorData, questions),
    });
  }catch(err){
    sendJson(res, 400, { ok: false, error: err?.message || String(err) });
  }
}

function finiteNumber(value, fallback = null){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampRatio(value, fallback = 0){
  const n = finiteNumber(value, fallback);
  return Math.max(0, Math.min(1, Number(n)));
}

function cleanManualQuestionAnchor(value, q){
  if (!value || typeof value !== "object") return null;
  const page = Math.trunc(finiteNumber(value.page, 0));
  const yRatio = clampRatio(value.yRatio ?? value.ratio, null);
  const xRatio = clampRatio(value.xRatio, 0.05);
  if (!page || !Number.isFinite(yRatio)) return null;
  return {
    ...value,
    q,
    label: value.label || q,
    page,
    ratio: yRatio,
    yRatio,
    xRatio,
    wRatio: Math.max(0.001, Math.min(0.2, finiteNumber(value.wRatio, 0.02))),
    hRatio: Math.max(0.001, Math.min(0.2, finiteNumber(value.hRatio, 0.018))),
    source: "manual-anchor",
    anchorMode: value.anchorMode || "center",
    confidence: 1,
  };
}

function cleanManualChoiceAnchor(value, q){
  if (!value || typeof value !== "object") return null;
  const page = Math.trunc(finiteNumber(value.page, 0));
  const choice = Math.trunc(finiteNumber(value.choice, 0));
  const xRatio = clampRatio(value.xRatio, null);
  const yRatio = clampRatio(value.yRatio, null);
  if (!page || !choice || !Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return null;
  return {
    ...value,
    q,
    choice,
    page,
    xRatio,
    yRatio,
    wRatio: Math.max(0.001, Math.min(0.2, finiteNumber(value.wRatio, 0.018))),
    hRatio: Math.max(0.001, Math.min(0.2, finiteNumber(value.hRatio, 0.018))),
    source: "manual-anchor",
    anchorMode: value.anchorMode || "center",
    confidence: 1,
  };
}

function cleanManualChoiceClickArea(value, q){
  if (!value || typeof value !== "object") return null;
  const page = Math.trunc(finiteNumber(value.page, 0));
  const choice = Math.trunc(finiteNumber(value.choice, 0));
  const xRatio = clampRatio(value.xRatio, null);
  const yRatio = clampRatio(value.yRatio, null);
  const wRatio = Math.max(0.001, Math.min(1, finiteNumber(value.wRatio, null)));
  const hRatio = Math.max(0.001, Math.min(1, finiteNumber(value.hRatio, null)));
  if (!page || !choice || !Number.isFinite(xRatio) || !Number.isFinite(yRatio) || !Number.isFinite(wRatio) || !Number.isFinite(hRatio)) return null;
  if (xRatio + wRatio <= 0 || yRatio + hRatio <= 0) return null;
  return {
    ...value,
    q,
    choice,
    page,
    xRatio: Math.max(0, Math.min(1, xRatio)),
    yRatio: Math.max(0, Math.min(1, yRatio)),
    wRatio: Math.max(0.001, Math.min(1 - Math.max(0, Math.min(1, xRatio)), wRatio)),
    hRatio: Math.max(0.001, Math.min(1 - Math.max(0, Math.min(1, yRatio)), hRatio)),
    source: "manual-click-area",
    confidence: 1,
  };
}

function cleanManualQuestionSegment(value){
  if (!value || typeof value !== "object") return null;
  const page = Math.trunc(finiteNumber(value.page, 0));
  const top = clampRatio(value.top, null);
  const bottom = clampRatio(value.bottom, null);
  const left = clampRatio(value.left, 0);
  const right = clampRatio(value.right, 1);
  if (!page || !Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top || right <= left) return null;
  return { page, top, bottom, left, right, source: "manual-anchor" };
}

function cloneJsonValue(value){
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function stableAnchorValue(value){
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableAnchorValue).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableAnchorValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeManualComparableValue(key, value){
  if (value === undefined) return null;
  if ((key === "questionSegments" || key === "choiceAnchorMap" || key === "choiceClickAreaMap") && Array.isArray(value) && value.length === 0) return null;
  return value ?? null;
}

function sameManualAnchorValue(key, a, b){
  return stableAnchorValue(normalizeManualComparableValue(key, a)) === stableAnchorValue(normalizeManualComparableValue(key, b));
}

function anchorMapStoredValue(anchorData, key, storeKey){
  const values = anchorData?.[key];
  if (Array.isArray(values)) {
    const q = Math.trunc(finiteNumber(storeKey, 0));
    return q > 0 && Object.prototype.hasOwnProperty.call(values, q) ? values[q] : null;
  }
  if (values && typeof values === "object") {
    return Object.prototype.hasOwnProperty.call(values, storeKey) ? values[storeKey] : null;
  }
  return null;
}

function setAnchorMapStoredValue(anchorData, key, storeKey, value){
  const q = Math.trunc(finiteNumber(storeKey, 0));
  if (Array.isArray(anchorData[key])) {
    if (q <= 0) return;
    if (value == null) delete anchorData[key][q];
    else anchorData[key][q] = cloneJsonValue(value);
    return;
  }
  if (!anchorData[key] || typeof anchorData[key] !== "object" || Array.isArray(anchorData[key])) anchorData[key] = {};
  if (value == null || ((key === "questionSegments" || key === "choiceAnchorMap" || key === "choiceClickAreaMap") && Array.isArray(value) && !value.length)) {
    delete anchorData[key][storeKey];
  } else {
    anchorData[key][storeKey] = cloneJsonValue(value);
  }
}

function manualBaseValue(anchorData, key, storeKey){
  const group = anchorData?._manualBase?.[key];
  if (!group || typeof group !== "object") return { exists: false, value: null };
  if (!Object.prototype.hasOwnProperty.call(group, storeKey)) return { exists: false, value: null };
  return { exists: true, value: group[storeKey] ?? null };
}

function restorePatchValueFromManualBaseIfSame(anchorData, key, storeKey, value){
  const base = manualBaseValue(anchorData, key, storeKey);
  if (!base.exists) return false;
  if (!sameManualAnchorValue(key, value, base.value)) return false;
  setAnchorMapStoredValue(anchorData, key, storeKey, base.value);
  delete anchorData._manualBase[key][storeKey];
  return true;
}

function manualBaseHasActualDifference(anchorData, keys){
  const base = anchorData?._manualBase;
  if (!base || typeof base !== "object") return false;
  for (const key of keys){
    const group = base[key];
    if (!group || typeof group !== "object") continue;
    for (const [storeKey, baseValue] of Object.entries(group)){
      const currentValue = anchorMapStoredValue(anchorData, key, storeKey);
      if (!sameManualAnchorValue(key, currentValue, baseValue)) return true;
    }
  }
  return false;
}

function compactManualAnchorBase(anchorData){
  const base = anchorData?._manualBase;
  if (!base || typeof base !== "object") {
    delete anchorData._manualBase;
    return;
  }
  for (const key of Object.keys(base)){
    const group = base[key];
    if (!group || typeof group !== "object") {
      delete base[key];
      continue;
    }
    for (const [storeKey, baseValue] of Object.entries(group)){
      const currentValue = anchorMapStoredValue(anchorData, key, storeKey);
      if (sameManualAnchorValue(key, currentValue, baseValue)) delete group[storeKey];
    }
    if (!Object.keys(group).length) delete base[key];
  }
  if (!Object.keys(base).length) delete anchorData._manualBase;
}

function normalizeManualAnchorState(anchorData){
  compactManualAnchorBase(anchorData);
  const meta = anchorManualEditMeta(anchorData);
  if (!meta.hasManualEdits) delete anchorData.manualEditedAt;
  return meta;
}

function ensureManualAnchorBase(anchorData, patch = {}){
  if (!anchorData._manualBase || typeof anchorData._manualBase !== "object") anchorData._manualBase = {};
  for (const key of ["questionLabelMap", "questionPageMap", "questionTopRatioMap", "questionSegments", "choiceAnchorMap", "choiceClickAreaMap"]){
    const values = patch[key];
    if (!values || typeof values !== "object") continue;
    if (!anchorData._manualBase[key] || typeof anchorData._manualBase[key] !== "object") anchorData._manualBase[key] = {};
    for (const qKey of Object.keys(values)){
      const q = Math.trunc(finiteNumber(qKey, 0));
      if (q <= 0) continue;
      const storeKey = String(q);
      if (Object.prototype.hasOwnProperty.call(anchorData._manualBase[key], storeKey)) continue;
      if (Array.isArray(anchorData[key])) anchorData._manualBase[key][storeKey] = cloneJsonValue(anchorData[key][q]);
      else if (anchorData[key] && typeof anchorData[key] === "object") anchorData._manualBase[key][storeKey] = cloneJsonValue(anchorData[key][storeKey]);
      else anchorData._manualBase[key][storeKey] = null;
    }
  }
}

function restoreManualAnchorBase(anchorData, reset = {}){
  const scope = reset.scope === "question" || reset.scope === "choice" || reset.scope === "choiceArea" || reset.scope === "choiceAreaAll" || reset.scope === "anchorAll" ? reset.scope : "all";
  const q = Math.trunc(finiteNumber(reset.q, 0));
  if (scope !== "choiceAreaAll" && scope !== "anchorAll" && q <= 0) throw new Error("초기화할 문제 번호가 없습니다.");
  const choice = Math.trunc(finiteNumber(reset.choice, 0));
  const storeKey = String(q);
  const base = anchorData._manualBase && typeof anchorData._manualBase === "object" ? anchorData._manualBase : {};
  const questionKeys = ["questionLabelMap", "questionPageMap", "questionTopRatioMap", "questionSegments"];

  const restoreAllEntriesForKey = (key) => {
    const keyBase = base[key] && typeof base[key] === "object" ? base[key] : {};
    for (const entryKey of Object.keys(keyBase)) {
      const value = cloneJsonValue(keyBase[entryKey]);
      const currentValue = anchorMapStoredValue(anchorData, key, entryKey);
      const emptyBase = value == null || ((key === "questionSegments" || key === "choiceAnchorMap" || key === "choiceClickAreaMap") && Array.isArray(value) && !value.length);
      const currentHasAnchors = Array.isArray(currentValue) && currentValue.length > 0;
      if (emptyBase && currentHasAnchors && (key === "choiceAnchorMap" || key === "questionSegments")) {
        delete keyBase[entryKey];
        continue;
      }
      setAnchorMapStoredValue(anchorData, key, entryKey, value);
      delete keyBase[entryKey];
    }
  };

  const restoreWholeKey = (key) => {
    const keyBase = base[key] && typeof base[key] === "object" ? base[key] : {};
    if (!Object.prototype.hasOwnProperty.call(keyBase, storeKey)) return;
    const value = cloneJsonValue(keyBase[storeKey]);
    if (Array.isArray(anchorData[key])) {
      if (value == null) delete anchorData[key][q];
      else anchorData[key][q] = value;
    } else {
      if (!anchorData[key] || typeof anchorData[key] !== "object") anchorData[key] = {};
      if (value == null) delete anchorData[key][storeKey];
      else anchorData[key][storeKey] = value;
    }
    delete keyBase[storeKey];
  };

  if (scope === "anchorAll") {
    for (const key of [...questionKeys, "choiceAnchorMap"]) restoreAllEntriesForKey(key);
    if (anchorData._manualBase && typeof anchorData._manualBase === "object") {
      for (const key of Object.keys(anchorData._manualBase)) {
        if (anchorData._manualBase[key] && typeof anchorData._manualBase[key] === "object" && !Object.keys(anchorData._manualBase[key]).length) {
          delete anchorData._manualBase[key];
        }
      }
      if (!Object.keys(anchorData._manualBase).length) delete anchorData._manualBase;
    }
    const now = new Date().toISOString();
    const manualMeta = normalizeManualAnchorState(anchorData);
    if (manualMeta.hasManualEdits) anchorData.manualEditedAt = now;
    else delete anchorData.manualEditedAt;
    anchorData.generatedAt = now;
    return anchorData;
  };

  if (scope === "all" || scope === "anchorAll" || scope === "question") {
    for (const key of questionKeys) restoreWholeKey(key);
  }

  if (scope === "choiceAreaAll") {
    const keyBase = base.choiceClickAreaMap && typeof base.choiceClickAreaMap === "object" ? base.choiceClickAreaMap : {};
    if (!anchorData.choiceClickAreaMap || typeof anchorData.choiceClickAreaMap !== "object") anchorData.choiceClickAreaMap = {};
    for (const key of Object.keys(keyBase)) {
      const value = cloneJsonValue(keyBase[key]);
      if (value == null || (Array.isArray(value) && !value.length)) delete anchorData.choiceClickAreaMap[key];
      else anchorData.choiceClickAreaMap[key] = value;
      delete keyBase[key];
    }
    for (const [key, value] of Object.entries(anchorData.choiceClickAreaMap || {})) {
      if (Object.prototype.hasOwnProperty.call(keyBase, key)) continue;
      const currentList = Array.isArray(value) ? value : [];
      const nextList = currentList.filter((item) => !String(item?.source || "").includes("manual-click-area"));
      if (nextList.length) anchorData.choiceClickAreaMap[key] = nextList;
      else delete anchorData.choiceClickAreaMap[key];
    }
  }

  if (scope === "anchorAll") {
    restoreWholeKey("choiceAnchorMap");
  } else if (scope === "all") {
    restoreWholeKey("choiceAnchorMap");
    restoreWholeKey("choiceClickAreaMap");
  } else if (scope === "choice" || scope === "choiceArea") {
    if (choice <= 0) throw new Error("초기화할 문항 번호가 없습니다.");
    const mapKeys = scope === "choiceArea" ? ["choiceClickAreaMap"] : ["choiceAnchorMap", "choiceClickAreaMap"];
    for (const mapKey of mapKeys) {
      const keyBase = base[mapKey] && typeof base[mapKey] === "object" ? base[mapKey] : {};
      if (Object.prototype.hasOwnProperty.call(keyBase, storeKey)) {
        const baseList = Array.isArray(keyBase[storeKey]) ? cloneJsonValue(keyBase[storeKey]) : [];
        const baseChoice = baseList.find((item) => Number(item?.choice) === choice) || null;
        const currentList = Array.isArray(anchorData[mapKey]?.[storeKey]) ? cloneJsonValue(anchorData[mapKey][storeKey]) : [];
        const nextList = currentList.filter((item) => Number(item?.choice) !== choice);
        if (baseChoice) nextList.push(baseChoice);
        nextList.sort((a, b) => Number(a.choice) - Number(b.choice) || Number(a.yRatio) - Number(b.yRatio) || Number(a.xRatio) - Number(b.xRatio));
        if (!anchorData[mapKey] || typeof anchorData[mapKey] !== "object") anchorData[mapKey] = {};
        if (nextList.length) anchorData[mapKey][storeKey] = nextList;
        else delete anchorData[mapKey][storeKey];
        const currentJson = JSON.stringify(anchorData[mapKey]?.[storeKey] || null);
        const baseJson = JSON.stringify(baseList.length ? baseList : null);
        if (currentJson === baseJson) delete keyBase[storeKey];
      } else if (scope === "choiceArea" && mapKey === "choiceClickAreaMap") {
        const currentList = Array.isArray(anchorData[mapKey]?.[storeKey]) ? cloneJsonValue(anchorData[mapKey][storeKey]) : [];
        const nextList = currentList.filter((item) => Number(item?.choice) !== choice);
        if (!anchorData[mapKey] || typeof anchorData[mapKey] !== "object") anchorData[mapKey] = {};
        if (nextList.length) anchorData[mapKey][storeKey] = nextList;
        else delete anchorData[mapKey][storeKey];
      }
    }
  }

  if (anchorData._manualBase && typeof anchorData._manualBase === "object") {
    for (const key of Object.keys(anchorData._manualBase)) {
      if (anchorData._manualBase[key] && typeof anchorData._manualBase[key] === "object" && !Object.keys(anchorData._manualBase[key]).length) {
        delete anchorData._manualBase[key];
      }
    }
    if (!Object.keys(anchorData._manualBase).length) delete anchorData._manualBase;
  }

  const now = new Date().toISOString();
  const manualMeta = normalizeManualAnchorState(anchorData);
  if (manualMeta.hasManualEdits) anchorData.manualEditedAt = now;
  else delete anchorData.manualEditedAt;
  anchorData.generatedAt = now;
  return anchorData;
}

function restoreAllManualAnchorBase(anchorData){
  const base = anchorData?._manualBase && typeof anchorData._manualBase === "object" ? anchorData._manualBase : null;
  let restored = 0;
  if (base) {
    for (const [key, values] of Object.entries(base)){
      if (!values || typeof values !== "object") continue;
      for (const [storeKey, rawValue] of Object.entries(values)){
        const q = Math.trunc(finiteNumber(storeKey, 0));
        if (q <= 0) continue;
        const value = cloneJsonValue(rawValue);
        const currentValue = anchorMapStoredValue(anchorData, key, storeKey);
        const emptyBase = value == null || ((key === "questionSegments" || key === "choiceAnchorMap" || key === "choiceClickAreaMap") && Array.isArray(value) && !value.length);
        const currentHasAnchors = Array.isArray(currentValue) && currentValue.length > 0;
        if (emptyBase && currentHasAnchors && (key === "choiceAnchorMap" || key === "questionSegments")) {
          restored += 1;
          continue;
        }
        if (Array.isArray(anchorData[key])) {
          if (value == null) delete anchorData[key][q];
          else anchorData[key][q] = value;
        } else {
          if (!anchorData[key] || typeof anchorData[key] !== "object") anchorData[key] = {};
          if (value == null) delete anchorData[key][storeKey];
          else anchorData[key][storeKey] = value;
        }
        restored += 1;
      }
    }
    delete anchorData._manualBase;
    delete anchorData.manualEditedAt;
  } else {
    const manualQuestionKeys = new Set();
    const isManualValue = (value) => value && typeof value === "object" && String(value.source || "").includes("manual");
    if (anchorData.questionLabelMap && typeof anchorData.questionLabelMap === "object") {
      for (const [storeKey, value] of Object.entries(anchorData.questionLabelMap)) {
        if (!isManualValue(value)) continue;
        const q = Math.trunc(finiteNumber(storeKey, 0));
        if (q > 0) manualQuestionKeys.add(String(q));
        delete anchorData.questionLabelMap[storeKey];
        restored += 1;
      }
    }
    for (const storeKey of manualQuestionKeys) {
      const q = Math.trunc(finiteNumber(storeKey, 0));
      if (q > 0) {
        if (Array.isArray(anchorData.questionPageMap)) delete anchorData.questionPageMap[q];
        if (Array.isArray(anchorData.questionTopRatioMap)) delete anchorData.questionTopRatioMap[q];
      }
      if (anchorData.questionSegments && typeof anchorData.questionSegments === "object") delete anchorData.questionSegments[storeKey];
    }
    if (anchorData.questionSegments && typeof anchorData.questionSegments === "object") {
      for (const [storeKey, value] of Object.entries(anchorData.questionSegments)) {
        const list = Array.isArray(value) ? value : [value];
        if (!list.some(isManualValue)) continue;
        delete anchorData.questionSegments[storeKey];
        restored += 1;
      }
    }
    if (anchorData.choiceAnchorMap && typeof anchorData.choiceAnchorMap === "object") {
      for (const [storeKey, value] of Object.entries(anchorData.choiceAnchorMap)) {
        const list = Array.isArray(value) ? value : [];
        const next = list.filter((item) => !isManualValue(item));
        if (next.length === list.length) continue;
        if (next.length) anchorData.choiceAnchorMap[storeKey] = next;
        else delete anchorData.choiceAnchorMap[storeKey];
        restored += list.length - next.length;
      }
    }
    if (anchorData.choiceClickAreaMap && typeof anchorData.choiceClickAreaMap === "object") {
      for (const [storeKey, value] of Object.entries(anchorData.choiceClickAreaMap)) {
        const list = Array.isArray(value) ? value : [];
        const next = list.filter((item) => !isManualValue(item));
        if (next.length === list.length) continue;
        if (next.length) anchorData.choiceClickAreaMap[storeKey] = next;
        else delete anchorData.choiceClickAreaMap[storeKey];
        restored += list.length - next.length;
      }
    }
    delete anchorData.manualEditedAt;
  }
  if (restored > 0) anchorData.generatedAt = new Date().toISOString();
  return restored;
}

function applyManualAnchorPatch(anchorData, patch = {}){
  if (!patch || typeof patch !== "object") throw new Error("저장할 위치맵 패치가 없습니다.");
  ensureManualAnchorBase(anchorData, patch);

  if (patch.questionLabelMap && typeof patch.questionLabelMap === "object"){
    if (!anchorData.questionLabelMap || typeof anchorData.questionLabelMap !== "object") anchorData.questionLabelMap = {};
    for (const [key, value] of Object.entries(patch.questionLabelMap)){
      const q = Math.trunc(finiteNumber(key, 0));
      const storeKey = String(q);
      if (q > 0 && restorePatchValueFromManualBaseIfSame(anchorData, "questionLabelMap", storeKey, value)) continue;
      if (q > 0 && value == null) {
        delete anchorData.questionLabelMap[storeKey];
        continue;
      }
      const cleaned = cleanManualQuestionAnchor(value, q);
      if (q > 0 && cleaned) anchorData.questionLabelMap[storeKey] = cleaned;
    }
  }

  if (patch.questionPageMap && typeof patch.questionPageMap === "object"){
    if (!Array.isArray(anchorData.questionPageMap)) anchorData.questionPageMap = [];
    for (const [key, value] of Object.entries(patch.questionPageMap)){
      const q = Math.trunc(finiteNumber(key, 0));
      const storeKey = String(q);
      if (q > 0 && restorePatchValueFromManualBaseIfSame(anchorData, "questionPageMap", storeKey, value)) continue;
      if (q > 0 && value == null) {
        delete anchorData.questionPageMap[q];
        continue;
      }
      const page = Math.trunc(finiteNumber(value, 0));
      if (q > 0 && page > 0) anchorData.questionPageMap[q] = page;
    }
  }

  if (patch.questionTopRatioMap && typeof patch.questionTopRatioMap === "object"){
    if (!Array.isArray(anchorData.questionTopRatioMap)) anchorData.questionTopRatioMap = [];
    for (const [key, value] of Object.entries(patch.questionTopRatioMap)){
      const q = Math.trunc(finiteNumber(key, 0));
      const storeKey = String(q);
      if (q > 0 && restorePatchValueFromManualBaseIfSame(anchorData, "questionTopRatioMap", storeKey, value)) continue;
      if (q > 0 && value == null) {
        delete anchorData.questionTopRatioMap[q];
        continue;
      }
      const ratio = clampRatio(value, null);
      if (q > 0 && Number.isFinite(ratio)) anchorData.questionTopRatioMap[q] = ratio;
    }
  }

  if (patch.questionSegments && typeof patch.questionSegments === "object"){
    if (!anchorData.questionSegments || typeof anchorData.questionSegments !== "object") anchorData.questionSegments = {};
    for (const [key, value] of Object.entries(patch.questionSegments)){
      const q = Math.trunc(finiteNumber(key, 0));
      const storeKey = String(q);
      if (q > 0 && restorePatchValueFromManualBaseIfSame(anchorData, "questionSegments", storeKey, value)) continue;
      if (q > 0 && value == null) {
        delete anchorData.questionSegments[storeKey];
        continue;
      }
      const segments = (Array.isArray(value) ? value : [value]).map(cleanManualQuestionSegment).filter(Boolean);
      if (q > 0 && segments.length) anchorData.questionSegments[storeKey] = segments;
    }
  }

  if (patch.choiceAnchorMap && typeof patch.choiceAnchorMap === "object"){
    if (!anchorData.choiceAnchorMap || typeof anchorData.choiceAnchorMap !== "object") anchorData.choiceAnchorMap = {};
    for (const [key, value] of Object.entries(patch.choiceAnchorMap)){
      const q = Math.trunc(finiteNumber(key, 0));
      const storeKey = String(q);
      if (q > 0 && restorePatchValueFromManualBaseIfSame(anchorData, "choiceAnchorMap", storeKey, value)) continue;
      if (q > 0 && (value == null || (Array.isArray(value) && !value.length))) {
        delete anchorData.choiceAnchorMap[storeKey];
        continue;
      }
      const anchors = (Array.isArray(value) ? value : [value])
        .map((item) => cleanManualChoiceAnchor(item, q))
        .filter(Boolean)
        .sort((a, b) => a.choice - b.choice || a.yRatio - b.yRatio || a.xRatio - b.xRatio);
      if (q > 0 && anchors.length) anchorData.choiceAnchorMap[storeKey] = anchors;
      else if (q > 0) delete anchorData.choiceAnchorMap[storeKey];
    }
  }

  if (patch.choiceClickAreaMap && typeof patch.choiceClickAreaMap === "object"){
    if (!anchorData.choiceClickAreaMap || typeof anchorData.choiceClickAreaMap !== "object") anchorData.choiceClickAreaMap = {};
    for (const [key, value] of Object.entries(patch.choiceClickAreaMap)){
      const q = Math.trunc(finiteNumber(key, 0));
      const storeKey = String(q);
      if (q > 0 && restorePatchValueFromManualBaseIfSame(anchorData, "choiceClickAreaMap", storeKey, value)) continue;
      if (q > 0 && (value == null || (Array.isArray(value) && !value.length))) {
        delete anchorData.choiceClickAreaMap[storeKey];
        continue;
      }
      const areas = (Array.isArray(value) ? value : [value])
        .map((item) => cleanManualChoiceClickArea(item, q))
        .filter(Boolean)
        .sort((a, b) => a.choice - b.choice || a.yRatio - b.yRatio || a.xRatio - b.xRatio);
      if (q > 0 && areas.length) anchorData.choiceClickAreaMap[storeKey] = areas;
      else if (q > 0) delete anchorData.choiceClickAreaMap[storeKey];
    }
  }

  const now = new Date().toISOString();
  const manualMeta = normalizeManualAnchorState(anchorData);
  if (manualMeta.hasManualEdits) anchorData.manualEditedAt = now;
  else delete anchorData.manualEditedAt;
  anchorData.generatedAt = now;
  return anchorData;
}

function cloneAnchorObject(value){
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return cloneJsonValue(value);
}

function normalizeInitialAnchorArray(value, count, mapper, label){
  if (!Array.isArray(value) || value.length < count + 1) {
    throw new Error(`${label} 정보가 부족해 위치맵을 생성할 수 없습니다.`);
  }
  const out = Array(count + 1).fill(null);
  for (let q = 1; q <= count; q += 1){
    const next = mapper(value[q], q);
    if (next == null) throw new Error(`${label} ${q}번 정보가 없어 위치맵을 생성할 수 없습니다.`);
    out[q] = next;
  }
  return out;
}

function normalizeInitialAnchorData(raw, rel, body = {}){
  if (!raw || typeof raw !== "object") throw new Error("초기 위치맵 데이터가 없습니다.");
  if (raw.kind && raw.kind !== "question-anchor-map") throw new Error("question-anchor-map 형식이 아닙니다.");
  const inferredCount = Array.isArray(raw.questionPageMap) ? raw.questionPageMap.length - 1 : 0;
  const questionCount = Math.trunc(finiteNumber(raw.questionCount || body.questionCount || inferredCount, 0));
  if (questionCount <= 0 || questionCount > 999) throw new Error("문항 수 정보가 없어 위치맵을 생성할 수 없습니다.");
  const choiceCount = Math.max(1, Math.min(5, Math.trunc(finiteNumber(raw.choiceCount || body.choiceCount, 4))));
  const pageMap = normalizeInitialAnchorArray(
    raw.questionPageMap,
    questionCount,
    (value) => {
      const page = Math.trunc(finiteNumber(value, 0));
      return page > 0 ? page : null;
    },
    "문제 페이지"
  );
  const topMap = normalizeInitialAnchorArray(
    raw.questionTopRatioMap,
    questionCount,
    (value) => {
      const ratio = clampRatio(value, null);
      return Number.isFinite(ratio) ? ratio : null;
    },
    "문제 시작 위치"
  );
  const now = new Date().toISOString();
  const questionStartNo = Math.trunc(finiteNumber(raw.questionStartNo || body.questionStartNo, 1)) || 1;
  const questionEndNo = Math.trunc(finiteNumber(raw.questionEndNo || body.questionEndNo, 0)) || (questionStartNo + questionCount - 1);
  const questionPdf = stripManifestPrefix(raw.questionPdf || body.questionPdf || body.path || "");
  return {
    kind: "question-anchor-map",
    version: Math.trunc(finiteNumber(raw.version, 1)) || 1,
    questionNo: String(raw.questionNo || body.questionNo || ""),
    questionPdf,
    pageCount: Math.trunc(finiteNumber(raw.pageCount, 0)) || null,
    questionCount,
    choiceCount,
    questionStartNo,
    questionEndNo,
    printedQuestionNoMap: Array.isArray(raw.printedQuestionNoMap) ? raw.printedQuestionNoMap.slice(0, questionCount + 1) : null,
    questionLabelMap: cloneAnchorObject(raw.questionLabelMap),
    questionColumnBoundsMap: cloneAnchorObject(raw.questionColumnBoundsMap),
    questionPageMap: pageMap,
    questionTopRatioMap: topMap,
    questionSegments: cloneAnchorObject(raw.questionSegments),
    choiceAnchorMap: cloneAnchorObject(raw.choiceAnchorMap),
    choiceClickAreaMap: cloneAnchorObject(raw.choiceClickAreaMap),
    confidence: Math.max(0, Math.min(1, finiteNumber(raw.confidence, 0.32))),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map((item) => String(item || "")).filter(Boolean).slice(0, 50) : [],
    generatedAt: raw.generatedAt || now,
    source: raw.source || "manual-bootstrap",
    output: rel,
  };
}

function manualAnchorManifestFields(rel, anchorData){
  return {
    anchorMap: `quiz/${rel}`,
    anchorStatus: Number(anchorData.confidence || 0) >= 0.32 ? "위치맵 생성" : "위치맵 확인 필요",
    anchorConfidence: Number(anchorData.confidence || 0),
    anchorWarnings: Array.isArray(anchorData.warnings) ? anchorData.warnings : [],
    anchorGeneratedAt: anchorData.generatedAt || new Date().toISOString(),
    questionStartNo: anchorData.questionStartNo || "",
    questionEndNo: anchorData.questionEndNo || "",
  };
}

async function updateAnchorManifestForManualSave(body, rel, anchorData){
  const found = findQuestionManifestRow(body);
  const fields = manualAnchorManifestFields(rel, anchorData);
  found.rows[found.index] = { ...found.rows[found.index], ...fields };
  await writeJsonFile(found.manifestName, found.rows);
  await updateCategoryQuestionManifest(found.row, fields);
}

async function clearAnchorManifestForManualBootstrap(body, rel){
  const found = findQuestionManifestRow(body);
  const currentAnchorMap = stripManifestPrefix(found.row?.anchorMap || "");
  if (currentAnchorMap && !sameManagedRelPath(currentAnchorMap, rel)) return false;
  found.rows[found.index] = withoutAnchorManifestFields(found.rows[found.index]);
  await writeJsonFile(found.manifestName, found.rows);
  await clearCategoryQuestionManifestAnchorFields(found.row);
  return true;
}

async function handleAnchorManualSave(req, res){
  try{
    const body = await readSmallJsonRequest(req);
    const requestedRel = normalizeAnchorMapRelPath(body.anchorMapPath || body.anchorMap || body.path);
    let rel = requestedRel;
    try{
      const found = findQuestionManifestRow(body);
      const manifestRel = inferAnchorMapPath(found.row);
      if (manifestRel && !sameManagedRelPath(manifestRel, requestedRel)) rel = manifestRel;
    }catch(_){}
    const abs = assertManagedPath(rel);
    let anchorData = null;
    try{
      anchorData = JSON.parse(await fsp.readFile(abs, "utf8"));
    }catch(err){
      if (err?.code !== "ENOENT" || body.resetManual || !body.baseAnchorData) throw err;
      anchorData = normalizeInitialAnchorData(body.baseAnchorData, rel, body);
    }
    if (anchorData.kind !== "question-anchor-map") throw new Error("question-anchor-map 형식이 아닙니다.");
    if (body.resetManual && typeof body.resetManual === "object") {
      restoreManualAnchorBase(anchorData, body.resetManual);
    } else {
      applyManualAnchorPatch(anchorData, body.patch || body);
    }
    const manualMeta = anchorManualEditMeta(anchorData);
    if (!manualMeta.hasManualEdits && String(anchorData.source || "") === "manual-bootstrap") {
      try{ await fsp.unlink(abs); }catch(err){ if (err?.code !== "ENOENT") throw err; }
      try{ await clearAnchorManifestForManualBootstrap(body, rel); }catch(_){}
      sendJson(res, 200, {
        ok: true,
        anchorMap: "",
        generatedAt: "",
        manualEditedAt: "",
        anchorData: null,
        deleted: true,
        noManualEdits: true,
        message: "수동 수정이 없어 임시 위치맵을 제거했습니다.",
      });
      return;
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, `${JSON.stringify(anchorData, null, 2)}\n`, "utf8");
    try{
      await updateAnchorManifestForManualSave(body, rel, anchorData);
    }catch(_){}
    sendJson(res, 200, { ok: true, anchorMap: rel, generatedAt: anchorData.generatedAt, manualEditedAt: anchorData.manualEditedAt, anchorData });
  }catch(err){
    sendJson(res, 400, { ok: false, error: err?.message || String(err) });
  }
}

async function handleAnchorManualDelete(req, res){
  try{
    const body = await readSmallJsonRequest(req);
    const requestedRel = normalizeAnchorMapRelPath(body.anchorMapPath || body.anchorMap || body.path);
    let rel = requestedRel;
    try{
      const found = findQuestionManifestRow(body);
      const manifestRel = inferAnchorMapPath(found.row);
      if (manifestRel && !sameManagedRelPath(manifestRel, requestedRel)) rel = manifestRel;
    }catch(_){}
    const abs = assertManagedPath(rel);
    const anchorData = JSON.parse(await fsp.readFile(abs, "utf8"));
    if (anchorData.kind !== "question-anchor-map") throw new Error("question-anchor-map 형식이 아닙니다.");
    const restored = restoreAllManualAnchorBase(anchorData);
    if (restored > 0) {
      await fsp.writeFile(abs, `${JSON.stringify(anchorData, null, 2)}\n`, "utf8");
      try{
        const found = findQuestionManifestRow(body);
        const fields = { anchorGeneratedAt: anchorData.generatedAt || new Date().toISOString() };
        found.rows[found.index] = { ...found.rows[found.index], ...fields };
        await writeJsonFile(found.manifestName, found.rows);
        await updateCategoryQuestionManifest(found.row, fields);
      }catch(_){}
    }
    sendJson(res, 200, {
      ok: true,
      anchorMap: rel,
      restored,
      generatedAt: anchorData.generatedAt || "",
      manualEditedAt: anchorData.manualEditedAt || "",
      message: restored > 0 ? "위치맵 수동 수정값을 원래 값으로 되돌렸습니다." : "원복할 위치맵 수동 수정값이 없습니다.",
    });
  }catch(err){
    sendJson(res, 400, { ok: false, message: err?.message || String(err) });
  }
}

function normalizeManagedPathList(value){
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return values
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .map((item) => stripManifestPrefix(item))
    .filter(Boolean);
}

function answerFileList(row = {}){
  const seen = new Set();
  const out = [];
  for (const value of [
    row.answerPdf,
    row.answerPdfs,
    row.answerFiles,
    row.answerPdfList,
    row.answerPdfPaths,
  ]){
    for (const rel of normalizeManagedPathList(value)){
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

function managedRelPath(value){
  const raw = String(value || "");
  if (path.isAbsolute(raw)) {
    try{
      return toRel(raw);
    }catch(_){
      return normalizeRelPath(raw);
    }
  }
  return stripManifestPrefix(raw);
}

function isDerivedPdfPath(value){
  const rel = managedRelPath(value);
  const base = path.posix.basename(rel).normalize("NFC");
  const stem = path.posix.parse(base).name.replace(/\s+/g, "");
  return base.startsWith(".") || /_(?:ocr_failed(?:_\d{14})?|ocr_rejected(?:_\d{14})?|ocr_fixed|ocrfixed|ocr|fixed|original(?:_\d{14}|\d{14})?)$/i.test(stem);
}

function originalCandidateForDerivedPdf(value){
  const rel = managedRelPath(value);
  const parsed = path.posix.parse(rel);
  const stem = parsed.name;
  const originalStem = stem.replace(/_(?:ocr_failed(?:_\d{14})?|ocr_rejected(?:_\d{14})?|ocr_fixed|ocrfixed|ocr|fixed|original(?:_\d{14}|\d{14})?)$/i, "");
  if (!originalStem || originalStem === stem) return "";
  return path.posix.join(parsed.dir, `${originalStem}${parsed.ext}`);
}
// SOFTM-OCR: OCR 결과/백업 PDF를 원본 문제 회차와 분리해 관리하도록 경로 판정 추가 - 2026-05-30
// SOFTM-OCR: 원본 후보 경로는 실제 파일명 유니코드 형태를 보존해 링크/존재 확인이 깨지지 않게 유지 - 2026-05-30

function manifestFileExists(value){
  const rel = stripManifestPrefix(value);
  if (!rel) return false;
  try{
    return fs.existsSync(resolveWorkspacePath(rel));
  }catch(_){
    return false;
  }
}

function manifestPublishedReady(row){
  const questionPdf = stripManifestPrefix(row?.questionPdf);
  if (!questionPdf) return false;
  if (isDerivedPdfPath(questionPdf)) return false;
  return manifestFileExists(questionPdf);
}

function questionAnswerCountIssue(row){
  const questionCount = Number(row?.questionCount || 0);
  const answerCount = Number(row?.answerCount || 0);
  if (questionCount > 0 && answerCount > 0 && questionCount !== answerCount) {
    return `문항/정답 수 불일치(${questionCount}/${answerCount})`;
  }
  return "";
}

function correctJsonReady(row){
  return Boolean(row?.correctJson && manifestFileExists(row.correctJson));
}

function answerSourceReady(row){
  return Boolean(String(row?.answerSourceId || "").trim());
}

function quizAnswerReady(row){
  return correctJsonReady(row) || answerSourceReady(row);
}

function isPublishedQuestion(row){
  return manifestPublishedReady(row);
}
// SOFTM-OCR: 문제 PDF 준비 상태와 정답 JSON 준비 상태를 분리해 최종 게시 가능 여부를 산정 - 2026-05-31

function collectDescendantCatNos(categories, catNo){
  const out = new Set([String(catNo || "")]);
  let changed = true;
  while (changed){
    changed = false;
    for (const category of categories || []){
      const parent = String(category?.parentCatNo || "");
      const current = String(category?.catNo || "");
      if (parent && current && out.has(parent) && !out.has(current)) {
        out.add(current);
        changed = true;
      }
    }
  }
  return out;
}

function categoryBreadcrumb(categories, row){
  const byNo = new Map((categories || []).map((item) => [String(item?.catNo || ""), item]));
  const parts = [];
  let current = row;
  const guard = new Set();
  while (current && !guard.has(String(current.catNo || ""))){
    guard.add(String(current.catNo || ""));
    parts.unshift(String(current.catNm || ""));
    current = byNo.get(String(current.parentCatNo || ""));
  }
  return parts.filter(Boolean).join(" / ");
}

function questionIssue(row){
  const questionPdf = stripManifestPrefix(row?.questionPdf);
  const answerPdf = stripManifestPrefix(row?.answerPdf);
  const correctJson = stripManifestPrefix(row?.correctJson);
  if (!questionPdf) return "문제 PDF 없음";
  if (isDerivedPdfPath(questionPdf)) return "OCR 파생 파일";
  if (!manifestFileExists(questionPdf)) return "문제 파일 없음";
  return "정상";
}

function inferAnchorMapPath(row){
  const explicit = stripManifestPrefix(row?.anchorMap || "");
  if (explicit && manifestFileExists(explicit)) return explicit;
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  if (!/\.pdf$/i.test(questionPdf)) return "";
  const inferred = questionPdf.replace(/\.pdf$/i, "_anchor.json");
  return manifestFileExists(inferred) ? inferred : "";
}
// SOFTM-위치맵: manifest에 남은 anchorMap 경로라도 실제 파일이 없으면 삭제된 위치맵과 동일하게 취급 - 2026-06-15

function containsManualAnchorValue(value){
  if (!value || typeof value !== "object") return false;
  if (String(value.source || "").includes("manual")) return true;
  if (String(value.anchorMode || "").includes("manual")) return true;
  if (Array.isArray(value)) return value.some(containsManualAnchorValue);
  return Object.values(value).some(containsManualAnchorValue);
}

function containsManualClickAreaValue(value){
  if (!value || typeof value !== "object") return false;
  if (String(value.source || "").includes("manual-click-area")) return true;
  if (Array.isArray(value)) return value.some(containsManualClickAreaValue);
  return Object.values(value).some(containsManualClickAreaValue);
}

function manualBaseHasAny(anchorData, keys){
  return manualBaseHasActualDifference(anchorData, keys);
}

function anchorManualEditMeta(anchorData){
  const anchorKeys = ["questionLabelMap", "questionPageMap", "questionTopRatioMap", "questionSegments", "choiceAnchorMap"];
  const hasAnchorPositionEdits = manualBaseHasAny(anchorData, anchorKeys)
    || containsManualAnchorValue(anchorData?.questionLabelMap)
    || containsManualAnchorValue(anchorData?.questionSegments)
    || containsManualAnchorValue(anchorData?.choiceAnchorMap);
  const hasQuestionAreaEdits = manualBaseHasAny(anchorData, ["choiceClickAreaMap"])
    || containsManualClickAreaValue(anchorData?.choiceClickAreaMap);
  return {
    hasManualEdits: Boolean(hasAnchorPositionEdits || hasQuestionAreaEdits),
    hasAnchorPositionEdits: Boolean(hasAnchorPositionEdits),
    hasQuestionAreaEdits: Boolean(hasQuestionAreaEdits),
  };
}

function hasManualAnchorEdits(anchorData){
  return anchorManualEditMeta(anchorData).hasManualEdits;
}

function questionWorkState(row, anchorMapPath, anchorMeta = {}){
  const steps = [];
  const correctJson = stripManifestPrefix(row?.correctJson || "");
  if (correctJson) steps.push(manifestFileExists(correctJson) ? "정답JSON" : "정답JSON 없음");
  if (anchorMapPath) steps.push("위치맵");
  if (anchorMeta.hasManualEdits) steps.push("위치맵 수정");
  if (isDerivedPdfPath(row?.questionPdf || "")) steps.push("OCR사본");
  return {
    initial: steps.length === 0,
    label: steps.length ? steps.join(" · ") : "초기",
    steps,
    tone: steps.length ? "ok" : "warn",
  };
}

function readAnchorMapMeta(relPath){
  const rel = stripManifestPrefix(relPath);
  if (!rel || !manifestFileExists(rel)) return {};
  try{
    const data = JSON.parse(fs.readFileSync(resolveWorkspacePath(rel), "utf8"));
    const manualMeta = anchorManualEditMeta(data);
    return {
      confidence: data.confidence,
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      generatedAt: data.generatedAt || "",
      manualEditedAt: data.manualEditedAt || "",
      ...manualMeta,
      status: Number(data.confidence || 0) >= 0.32 ? "위치맵 생성" : "위치맵 확인 필요",
    };
  }catch(_){
    return {};
  }
}

async function cachedPdfDiagnostics(relPath, options = {}){
  const rel = stripManifestPrefix(relPath);
  if (!rel) return null;
  let abs;
  try{
    abs = assertPdfManagedPath(rel);
  }catch(_){
    return null;
  }
  let stat;
  try{
    stat = fs.statSync(abs);
  }catch(_){
    return null;
  }
  const expected = expectedQuestionCount(options.meta);
  const key = `${options.docType || "question"}:${expected}:${rel}:${stat.size}:${stat.mtimeMs}`;
  if (pdfDiagnosticCache.has(key)) return pdfDiagnosticCache.get(key);
  const data = await pdfDiagnostics(rel, options);
  pdfDiagnosticCache.set(key, data);
  return data;
}

function ocrIssueFromDiagnostics(data){
  if (!data || !data.needsOcr) return "";
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (warnings.some((item) => String(item).includes("선택지 기호"))) return "OCR";
  if (warnings.some((item) => String(item).includes("문항번호") || String(item).includes("문항 수"))) return "OCR";
  return "PDF";
}

function diagTone(issue){
  if (!issue || issue === "정상") return "ok";
  if (String(issue).includes("없음") || String(issue).includes("파일")) return "warn";
  return "warn";
}

function questionDiagSummary(data){
  const issue = ocrIssueFromDiagnostics(data) || "정상";
  return {
    status: issue,
    tone: diagTone(issue),
    warnings: data?.warnings || [],
    textChars: data?.textChars || 0,
    charsPerPage: data?.charsPerPage || 0,
    questionLabels: data?.questionLabels || 0,
    uniqueQuestionLabels: data?.uniqueQuestionLabels || 0,
    choiceLabels: data?.choiceLabels || 0,
    expectedQuestionCount: data?.expectedQuestionCount || 0,
    expectedChoiceCount: data?.expectedChoiceCount || 0,
    questionDetectRate: data?.questionDetectRate ?? null,
    choiceDetectRate: data?.choiceDetectRate ?? null,
    textStatusLabel: data?.textStatusLabel || (issue === "정상" ? "정상" : issue === "OCR" ? "OCR 확인" : "PDF 확인"),
    textStatusReason: data?.textStatusReason || (data?.warnings || []).slice(0, 2).join(" / ") || "PDF 텍스트/구조 인식 기준 통과",
  };
}

function answerDiagSummary(row, data){
  const answerFiles = answerFileList(row);
  if (!answerFiles.length && !String(row?.answerSourceId || "").trim()) {
    return { status: "정답 없음", tone: "warn", warnings: ["정답 파일 또는 정답 원본 ID가 연결되지 않았습니다."] };
  }
  const missing = answerFiles.filter((item) => !manifestFileExists(item));
  if (answerFiles.length && missing.length === answerFiles.length) {
    return { status: "정답 파일 없음", tone: "warn", warnings: ["정답 파일 경로가 있지만 실제 파일을 찾을 수 없습니다."] };
  }
  const baseWarnings = missing.length ? [`일부 정답 파일을 찾을 수 없습니다(${missing.length}/${answerFiles.length}).`] : [];
  if (data?.needsOcr) {
    return {
      status: "정답 확인 필요",
      tone: "warn",
      warnings: [...baseWarnings, ...(data.warnings || [])],
      textChars: data.textChars || 0,
      answerPairs: data.answerPairs || 0,
    };
  }
  if (correctJsonReady(row)) {
    return { status: "정상", tone: "ok", warnings: baseWarnings, textChars: data?.textChars || 0, answerPairs: data?.answerPairs || 0 };
  }
  if (String(row?.correctJson || "").trim()) {
    return {
      status: "정답 JSON 없음",
      tone: "warn",
      warnings: [...baseWarnings, "정답 JSON 경로가 있지만 실제 파일을 찾을 수 없습니다."],
      textChars: data?.textChars || 0,
      answerPairs: data?.answerPairs || 0,
    };
  }
  if (String(row?.answerSourceId || "").trim()) {
    return { status: "정답 원본 연결", tone: "ok", warnings: baseWarnings, textChars: data?.textChars || 0, answerPairs: data?.answerPairs || 0 };
  }
  if (answerFiles.length) {
    return {
      status: "정답 JSON 필요",
      tone: "warn",
      warnings: [...baseWarnings, "정답 원본 파일은 연결되어 있지만 correct.json 연결이 없습니다. 정답 JSON을 생성하세요."],
      textChars: data?.textChars || 0,
      answerPairs: data?.answerPairs || 0,
    };
  }
  return { status: "정답 없음", tone: "warn", warnings: ["정답 파일 또는 정답 원본 ID가 연결되지 않았습니다."], textChars: data?.textChars || 0, answerPairs: data?.answerPairs || 0 };
}

async function buildCatalogDataset(dataset, datasetLabel, categories, questions){
  const categoryRows = Array.isArray(categories) ? categories : [];
  const questionRows = Array.isArray(questions) ? questions : [];
  const categoryByNo = new Map(categoryRows.map((row) => [String(row?.catNo || ""), row]));

  const normalizedQuestions = await Promise.all(questionRows.map(async (row) => {
    const category = categoryByNo.get(String(row?.catNo || "")) || {};
    const manifestReady = isPublishedQuestion(row);
    const fileIssue = questionIssue(row);
    const diagnostics = manifestFileExists(row?.questionPdf || "") ? await cachedPdfDiagnostics(row.questionPdf, { docType: "question", meta: row }) : null;
    const answerPdfs = answerFileList(row);
    const primaryAnswerPdf = answerPdfs[0] || "";
    const answerExt = path.extname(primaryAnswerPdf).toLowerCase();
    const answerDiagnostics = answerExt === ".pdf" && manifestFileExists(primaryAnswerPdf) ? await cachedPdfDiagnostics(primaryAnswerPdf, { docType: "answer", meta: row }) : null;
    const questionDiag = questionDiagSummary(diagnostics);
    const answerDiag = answerDiagSummary({ ...row, answerPdf: primaryAnswerPdf, answerPdfs }, answerDiagnostics);
    const anchorMapPath = inferAnchorMapPath(row);
    const anchorMeta = readAnchorMapMeta(anchorMapPath);
    const hasAnchorMapFile = Boolean(anchorMapPath);
    const workState = questionWorkState(row, anchorMapPath, anchorMeta);
    const ocrIssue = questionDiag.status !== "정상" ? questionDiag.status : "";
    const countIssue = questionAnswerCountIssue(row);
    const answerStatus = String(answerDiag.status || "");
    const answerReady = quizAnswerReady(row);
    const answerOk = answerReady && ["정상", "정답 원본 연결"].includes(answerStatus);
    const answerIssue = countIssue || (!answerReady ? "정답 JSON 없음" : (!answerOk ? answerDiag.status : ""));
    const published = manifestReady && fileIssue === "정상" && answerReady;
    const issue = fileIssue !== "정상" ? fileIssue : (answerIssue || fileIssue);
    const derivedPdf = isDerivedPdfPath(row?.questionPdf || "");
    const originalCandidatePath = derivedPdf ? originalCandidateForDerivedPdf(row?.questionPdf || "") : "";
    return {
      dataset,
      datasetLabel,
      gNo: row?.gNo || category.gNo || "",
      gNm: row?.gNm || category.gNm || "",
      catNo: row?.catNo || "",
      catNm: row?.catNm || category.catNm || "",
      parentCatNo: row?.parentCatNo || category.parentCatNo || "",
      categoryPath: stripManifestPrefix(category.catPath || ""),
      categoryFullName: categoryBreadcrumb(categoryRows, categoryByNo.get(String(row?.catNo || "")) || row),
      questionNo: row?.questionNo || "",
      questionNm: row?.questionNm || "",
      questionPdf: stripManifestPrefix(row?.questionPdf || ""),
      answerPdf: primaryAnswerPdf,
      answerPdfs,
      correctJson: stripManifestPrefix(row?.correctJson || ""),
      year: row?.year || "",
      semester: row?.semester || "",
      examType: row?.examType || "",
      questionCount: row?.questionCount || "",
      answerCount: row?.answerCount || "",
      questionStartNo: row?.questionStartNo || "",
      questionEndNo: row?.questionEndNo || "",
      answerStartNo: row?.answerStartNo || "",
      answerEndNo: row?.answerEndNo || "",
      choiceCount: row?.choiceCount || "",
      anchorMap: anchorMapPath,
      anchorStatus: hasAnchorMapFile ? (anchorMeta.status || row?.anchorStatus || "") : "",
      anchorConfidence: hasAnchorMapFile ? (anchorMeta.confidence ?? row?.anchorConfidence ?? "") : "",
      anchorWarnings: hasAnchorMapFile ? (Array.isArray(row?.anchorWarnings) && row.anchorWarnings.length ? row.anchorWarnings : (anchorMeta.warnings || [])) : [],
      anchorGeneratedAt: hasAnchorMapFile ? (anchorMeta.generatedAt || row?.anchorGeneratedAt || "") : "",
      anchorManualEditedAt: hasAnchorMapFile ? (anchorMeta.manualEditedAt || "") : "",
      hasManualAnchorEdits: hasAnchorMapFile && Boolean(anchorMeta.hasManualEdits),
      hasManualQuestionAreaEdits: hasAnchorMapFile && Boolean(anchorMeta.hasQuestionAreaEdits),
      hasManualAnchorPositionEdits: hasAnchorMapFile && Boolean(anchorMeta.hasAnchorPositionEdits),
      // SOFTM-위치맵: _anchor.json 파일이 임의 삭제된 경우 stale manifest 보조 필드도 UI 응답에서 제거 - 2026-06-15
      workState: workState.label,
      workStateSteps: workState.steps,
      workStateInitial: workState.initial,
      workStateTone: workState.tone,
      answerSourceId: row?.answerSourceId || "",
      answerReady,
      published,
      issue,
      fileIssue,
      derivedPdf,
      originalCandidatePath,
      originalCandidateExists: originalCandidatePath ? manifestFileExists(originalCandidatePath) : false,
      ocrIssue,
      needsOcr: Boolean(ocrIssue),
      ocrWarnings: diagnostics?.warnings || [],
      ocrTextChars: diagnostics?.textChars || 0,
      ocrCharsPerPage: diagnostics?.charsPerPage || 0,
      ocrQuestionLabels: diagnostics?.questionLabels || 0,
      ocrUniqueQuestionLabels: diagnostics?.uniqueQuestionLabels || 0,
      ocrChoiceLabels: diagnostics?.choiceLabels || 0,
      ocrChoiceVariantLabels: diagnostics?.choiceVariantLabels || 0,
      ocrBrokenHangulRuns: diagnostics?.brokenHangulRuns || 0,
      ocrExpectedQuestionCount: diagnostics?.expectedQuestionCount || 0,
      ocrExpectedChoiceCount: diagnostics?.expectedChoiceCount || 0,
      questionDetectRate: diagnostics?.questionDetectRate ?? null,
      choiceDetectRate: diagnostics?.choiceDetectRate ?? null,
      textStatusLabel: diagnostics?.textStatusLabel || questionDiag.textStatusLabel,
      textStatusReason: diagnostics?.textStatusReason || questionDiag.textStatusReason,
      questionDiagStatus: questionDiag.status,
      questionDiagTone: questionDiag.tone,
      questionDiagWarnings: questionDiag.warnings,
      answerDiagStatus: answerDiag.status,
      answerDiagTone: answerDiag.tone,
      answerDiagWarnings: answerDiag.warnings,
      answerIssue,
      answerTextChars: answerDiag.textChars || 0,
      answerPairs: answerDiag.answerPairs || 0,
      hasQuestionFile: manifestFileExists(row?.questionPdf || ""),
      hasAnswerFile: answerPdfs.length ? answerPdfs.some((item) => manifestFileExists(item)) : Boolean(row?.answerSourceId),
      hasCorrectJson: correctJsonReady(row),
      seq: Number(row?.seq || 0),
    };
  }));
  // SOFTM-OCR: 관리자 catalog의 게시/미게시 판정에서 OCR 품질 경고를 제거하고 별도 진단 필드로만 유지 - 2026-05-30
  // SOFTM-위치맵: 문제·문항 위치맵 상태를 회차 catalog에 포함해 상세 화면과 풀이 화면이 참조 가능하도록 연결 - 2026-05-30

  const normalizedCategories = categoryRows.map((row) => {
    const catNos = collectDescendantCatNos(categoryRows, row?.catNo);
    const rows = normalizedQuestions.filter((item) => catNos.has(String(item.catNo || "")));
    const published = rows.filter((item) => item.published).length;
    const answerMapped = rows.filter((item) => item.answerPdf || item.answerSourceId).length;
    const correctReady = rows.filter((item) => item.hasCorrectJson || item.answerSourceId).length;
    const ocrWarning = rows.filter((item) => item.needsOcr).length;
    return {
      dataset,
      datasetLabel,
      gNo: row?.gNo || "",
      gNm: row?.gNm || "",
      catNo: row?.catNo || "",
      catNm: row?.catNm || "",
      parentCatNo: row?.parentCatNo || "",
      catPath: stripManifestPrefix(row?.catPath || ""),
      depth: Number(row?.depth || 0),
      seq: Number(row?.seq || 0),
      fullName: categoryBreadcrumb(categoryRows, row),
      questionTotal: rows.length,
      published,
      unpublished: Math.max(0, rows.length - published),
      answerMapped,
      correctReady,
      ocrWarning,
      latestQuestion: rows.sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0))[0]?.questionNm || "",
    };
  });

  return { categories: normalizedCategories, questions: normalizedQuestions };
}

async function catalogState(){
  const defaults = await buildCatalogDataset("default", "PDF", readJsonFile("category.json", []), readJsonFile("question.json", []));
  const knou = await buildCatalogDataset("knou", "방통대 별도", readJsonFile("knou_category.json", []), readJsonFile("knou_question.json", []));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    categories: [...defaults.categories, ...knou.categories],
    questions: [...defaults.questions, ...knou.questions],
  };
}
/* SOFTM-ADMIN 끝 */

function listDir(rel){
  const abs = assertManagedPath(rel || "pdf");
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => {
      const full = path.join(abs, entry.name);
      const stat = fs.statSync(full);
      return {
        name: entry.name,
        path: toRel(full),
        type: entry.isDirectory() ? "dir" : "file",
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "ko") : (a.type === "dir" ? -1 : 1)));
  const parent = toRel(path.dirname(abs));
  return { cwd: toRel(abs), parent: parent.startsWith("pdf") || parent.startsWith("json") ? parent : "", entries };
}

async function manifestState(){
  const groups = readJsonFile("group.json", []);
  const categories = readJsonFile("category.json", []);
  const questions = readJsonFile("question.json", []);
  const knouGroups = readJsonFile("knou_group.json", []);
  const knouCategories = readJsonFile("knou_category.json", []);
  const knouQuestions = readJsonFile("knou_question.json", []);
  const knouAnswerSources = readJsonFile("knou_answer_sources.json", []);
  const catalog = await catalogState();
  const defaultPublished = catalog.questions.filter((row) => row.dataset === "default" && row.published).length;
  const knouPublished = catalog.questions.filter((row) => row.dataset === "knou" && row.published).length;
  return {
    root,
    counts: {
      groups: Array.isArray(groups) ? groups.length : 0,
      categories: Array.isArray(categories) ? categories.length : 0,
      questions: Array.isArray(questions) ? questions.length : 0,
      publishedQuestions: defaultPublished,
      knouGroups: Array.isArray(knouGroups) ? knouGroups.length : 0,
      knouCategories: Array.isArray(knouCategories) ? knouCategories.length : 0,
      knouQuestions: Array.isArray(knouQuestions) ? knouQuestions.length : 0,
      knouPublishedQuestions: knouPublished,
      knouAnswerSources: Array.isArray(knouAnswerSources) ? knouAnswerSources.length : 0,
    },
    recent: {
      knouQuestions: Array.isArray(knouQuestions) ? knouQuestions.slice(-8).reverse() : [],
      knouAnswerSources: Array.isArray(knouAnswerSources) ? knouAnswerSources.slice(-8).reverse() : [],
    },
  };
}
// SOFTM-OCR: 관리자 요약 카운트도 OCR 통과 회차만 게시 회차로 집계 - 2026-05-30

function bufferSplit(buf, sep){
  const out = [];
  let start = 0;
  let idx = buf.indexOf(sep, start);
  while (idx !== -1){
    out.push(buf.subarray(start, idx));
    start = idx + sep.length;
    idx = buf.indexOf(sep, start);
  }
  out.push(buf.subarray(start));
  return out;
}

function parseMultipart(req, body){
  const type = req.headers["content-type"] || "";
  const match = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("multipart boundary가 없습니다.");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = [];
  for (let part of bufferSplit(body, boundary)){
    if (part.length === 0) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1] || "";
    const fileName = disposition.match(/filename="([^"]*)"/)?.[1] || "";
    if (!name) continue;
    if (fileName) files.push({ field: name, fileName: path.basename(fileName), content });
    else fields[name] = content.toString("utf8");
  }
  return { fields, files };
}

function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        reject(new Error("업로드 용량 제한을 초과했습니다."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runImport(args){
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(scriptDir, "import-knou.mjs"), ...args], { cwd: root, maxBuffer: 40 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\n${stderr || stdout}`;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function gitStatus(){
  return new Promise((resolve) => {
    execFile("git", ["status", "--short"], { cwd: root, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        status: stdout.trimEnd(),
        error: err ? String(stderr || err.message).trim() : "",
      });
    });
  });
}

async function questionChangesReport(url){
  const base = String(url.searchParams.get("base") || "HEAD").trim() || "HEAD";
  if (base.length > 120 || /[\r\n]/.test(base)) throw new Error("비교 기준 ref가 올바르지 않습니다.");
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 80) || 80));
  const result = await runCommand(process.execPath, [
    path.join(scriptDir, "report-question-changes.mjs"),
    "--base", base,
    "--limit", String(limit),
    "--json",
  ], { maxBuffer: 80 * 1024 * 1024 });
  try{
    return JSON.parse(result.stdout || "{}");
  }catch(err){
    throw new Error(`문항 변경 리포트 파싱 실패: ${err?.message || err}`);
  }
}
// SOFTM-ADMIN: 관리자 화면에서 회차/문항 JSON 변경을 확인하는 리포트 API 추가 - 2026-06-03

/* SOFTM-ADMIN 시작: 문제 등록 프로세스 점검용 리포트 API 추가 - 2026-05-29 */
function walkManagedFiles(baseRel){
  const baseAbs = resolveWorkspacePath(baseRel);
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      out.push(full);
    }
  };
  visit(baseAbs);
  return out;
}

function isAnswerPath(rel){
  const normalized = normalizeRelPath(rel).normalize("NFC");
  const parts = normalized.split("/");
  const name = path.basename(normalized);
  const stem = name.replace(/\.[^.]+$/, "");
  return parts.includes("정답") || /(?:최종)?정답|정답표/.test(stem);
}

function processFileSummary(){
  const files = walkManagedFiles("pdf");
  const questionFiles = files.filter((file) => {
    const rel = toRel(file);
    return path.extname(file).toLowerCase() === ".pdf" && !isAnswerPath(rel);
  });
  const answerFiles = files.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return [".pdf", ".hwp"].includes(ext) && isAnswerPath(toRel(file));
  });
  const correctFiles = files.filter((file) => path.basename(file) === "correct.json");
  return {
    questionFiles: questionFiles.length,
    answerFiles: answerFiles.length,
    correctFiles: correctFiles.length,
  };
}

function fileInfo(rel){
  const abs = resolveWorkspacePath(rel);
  try{
    const stat = fs.statSync(abs);
    return { path: rel, exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
  }catch(_){
    return { path: rel, exists: false, size: 0, mtime: "" };
  }
}

function scriptInfo(scriptName){
  return fileInfo(`scripts/${scriptName}`);
}

function checkCommand(name){
  return new Promise((resolve) => {
    execFile("which", [name], { cwd: root }, (err, stdout) => {
      resolve({ name, ok: !err, path: stdout.trim() });
    });
  });
}

function runCommand(command, args, options = {}){
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: root,
      maxBuffer: options.maxBuffer || 80 * 1024 * 1024,
      timeout: options.timeout || 0,
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\n${stderr || stdout}`;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/* SOFTM-OCR 시작: 원본 문제/정답 PDF 진단 및 OCR 적용 API 추가 - 2026-05-29 */
const ocrJobs = new Map();
const ocrLogLimit = 160;
const ocrTimeoutMs = 30 * 60 * 1000;
const ocrEstimateMsPerPage = 45 * 1000;

function assertPdfManagedPath(value){
  const rel = normalizeRelPath(value).replace(/^quiz\//, "");
  if (!rel.startsWith("pdf/") || path.extname(rel).toLowerCase() !== ".pdf") {
    throw new Error("PDF 진단/OCR 대상은 pdf 하위의 .pdf 파일이어야 합니다.");
  }
  return resolveWorkspacePath(rel);
}

function parsePdfInfoText(text){
  const pageMatch = String(text || "").match(/^Pages:\s*(\d+)/mi);
  const encryptedMatch = String(text || "").match(/^Encrypted:\s*(.+)$/mi);
  const sizeMatch = String(text || "").match(/^Page size:\s*(.+)$/mi);
  return {
    pages: pageMatch ? Number(pageMatch[1]) : 0,
    encrypted: encryptedMatch ? encryptedMatch[1].trim() : "",
    pageSize: sizeMatch ? sizeMatch[1].trim() : "",
  };
}

function questionMetaForPdf(relPath){
  const normalized = stripManifestPrefix(relPath);
  const rows = [
    ...readJsonFile("question.json", []),
    ...readJsonFile("knou_question.json", []),
  ].filter((row) => row && typeof row === "object");
  const matched = rows.find((row) => sameManagedRelPath(row.questionPdf, normalized));
  if (matched) return matched;
  if (isDerivedPdfPath(normalized)) {
    const original = originalCandidateForDerivedPdf(normalized);
    return rows.find((row) => sameManagedRelPath(row.questionPdf, original)) || null;
  }
  return null;
}
// SOFTM-OCR: OCR 파생 PDF 진단 시 NFC/NFD 파일명 차이에도 원본 회차 문항 수를 매칭 - 2026-05-30

function expectedQuestionCount(meta){
  const explicit = Number(meta?.questionCount || 0);
  if (explicit > 0) return explicit;
  const start = Number(meta?.questionStartNo || 0);
  const end = Number(meta?.questionEndNo || 0);
  if (start > 0 && end >= start) return end - start + 1;
  return 0;
}

function questionLabelStats(text){
  const labels = [...String(text || "").matchAll(/(?:^|\n)\s*(\d{1,3})\s*(?:[.)]|번)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 1 && value <= 300);
  const unique = [...new Set(labels)].sort((a, b) => a - b);
  return {
    total: labels.length,
    unique: unique.length,
    min: unique[0] || 0,
    max: unique[unique.length - 1] || 0,
  };
}

function choiceLabelStats(text){
  const raw = String(text || "");
  const strong = (raw.match(/[①②③④⑤❶❷❸❹❺➀➁➂➃➄➊➋➌➍➎⓵⓶⓷⓸⓹㈠㈡㈢㈣㈤㊀㊁㊂㊃㊄㉠㉡㉢㉣㉤]/g) || []).length;
  const variantMatches = [
    ...raw.matchAll(/(?:^|[\s])(?:[0OQ@©®]\s*[).:]|Q@|QO|Qo|DO|OD|00|0Q|Q0)(?=\s*\S)/g),
    ...raw.matchAll(/(?:^|[\s])(?:[@©®])(?=\s*[가-힣A-Za-z0-9ㄱ-ㅎㅏ-ㅣ])/g),
  ];
  return { strong, variants: variantMatches.length, total: strong + variantMatches.length };
}

function countChoiceLabels(text){
  return choiceLabelStats(text).strong;
}

function countBrokenHangulRuns(text){
  const raw = String(text || "");
  let count = 0;
  for (const match of raw.matchAll(/(?:^|[\s\n])(?:[가-힣]\s+){3,}[가-힣](?=$|[\s\n.,!?])/g)) {
    const syllables = match[0].match(/[가-힣]/g) || [];
    if (syllables.length >= 4) count += 1;
  }
  return count;
}
// SOFTM-OCR: OCR 생성 성공과 실제 텍스트 품질을 분리하기 위해 선택지 깨짐/한글 음절 분리 지표 추가 - 2026-05-30

function countAnswerPairs(text){
  const normalized = String(text || "").replace(/[①②③④⑤]/g, (value) => String("①②③④⑤".indexOf(value) + 1));
  const matches = normalized.match(/(?:^|[\s,])(?:\d{1,3})\s*[:.)-]?\s*[1-5](?=\s|,|$)/g);
  return matches ? matches.length : 0;
}

async function pdfDiagnostics(relPath, options = {}){
  const abs = assertPdfManagedPath(relPath);
  const rel = toRel(abs);
  const stat = fs.statSync(abs);
  let pdfInfoRaw = "";
  let text = "";
  let textError = "";
  try{
    pdfInfoRaw = (await runCommand("pdfinfo", [abs], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  }catch(err){
    pdfInfoRaw = "";
    textError = String(err?.message || err);
  }
  try{
    text = (await runCommand("pdftotext", ["-layout", abs, "-"], { maxBuffer: 80 * 1024 * 1024 })).stdout;
  }catch(err){
    textError = String(err?.message || err);
  }
  const info = parsePdfInfoText(pdfInfoRaw);
  const pages = Number(info.pages || 0);
  const compactText = text.replace(/\s+/g, "");
  const koreanChars = (compactText.match(/[가-힣]/g) || []).length;
  const alphaNumChars = (compactText.match(/[0-9A-Za-z]/g) || []).length;
  const docType = options.docType || "question";
  const questionMeta = options.meta || questionMetaForPdf(rel);
  const expectedCount = expectedQuestionCount(questionMeta);
  const derivedPdf = isDerivedPdfPath(rel);
  const originalCandidatePath = derivedPdf ? originalCandidateForDerivedPdf(rel) : "";
  const labelStats = questionLabelStats(text);
  const questionLabels = labelStats.total;
  const choiceStats = choiceLabelStats(text);
  const choiceLabels = choiceStats.strong;
  const choiceVariantLabels = choiceStats.variants;
  const brokenHangulRuns = countBrokenHangulRuns(text);
  const answerPairs = countAnswerPairs(text);
  const charsPerPage = pages ? Math.round(compactText.length / pages) : compactText.length;
  const choiceCount = Math.max(1, Math.trunc(Number(questionMeta?.choiceCount || options.choiceCount || 4)) || 4);
  const expectedChoiceCount = docType === "answer" || !expectedCount ? 0 : expectedCount * choiceCount;
  const hasReliableQuestionStructure = docType !== "answer" && expectedCount && labelStats.unique >= expectedCount * 0.9 && choiceLabels >= expectedCount * 2;
  const qualityWarnings = [];
  const managementWarnings = [];
  if (!compactText.length) qualityWarnings.push("텍스트 레이어가 없습니다. OCR 적용이 필요합니다.");
  if (pages && charsPerPage < 120 && !hasReliableQuestionStructure) qualityWarnings.push("페이지당 추출 텍스트가 적습니다. 스캔 PDF이거나 OCR 품질이 낮을 수 있습니다.");
  if (brokenHangulRuns >= Math.max(6, Math.ceil((pages || 1) * 0.6))) qualityWarnings.push(`한글 음절이 과도하게 분리되어 있습니다(${brokenHangulRuns}개 구간). OCR 텍스트 품질이 낮습니다.`);
  if (docType === "answer") {
    if (expectedCount && answerPairs < Math.max(3, expectedCount * 0.6)) qualityWarnings.push(`예상 문항 수(${expectedCount}) 대비 정답 번호/값 감지가 부족합니다(${answerPairs}개).`);
  } else {
    if (pages && questionLabels < Math.min(5, Math.max(1, pages))) qualityWarnings.push("문항 번호 패턴이 적게 감지됩니다. 문제지 OCR 상태를 확인하세요.");
    if (expectedCount && labelStats.unique < Math.max(3, expectedCount * 0.75)) qualityWarnings.push(`예상 문항 수(${expectedCount}) 대비 고유 문항번호 감지가 부족합니다.`);
    if (expectedCount && questionLabels > expectedCount * 1.3) qualityWarnings.push(`예상 문항 수(${expectedCount})보다 문항번호가 과다 감지됩니다. OCR 오인식 가능성이 있습니다.`);
    if (expectedCount && choiceLabels < expectedCount * 2) {
      if (choiceVariantLabels >= expectedCount) qualityWarnings.push(`선택지 기호가 OCR 변형 토큰으로 인식되었습니다(정상 ${choiceLabels}개, 변형 ${choiceVariantLabels}개). OCR 품질을 확인하세요.`);
      else qualityWarnings.push(`선택지 기호 감지가 부족합니다(${choiceLabels}개). OCR 품질 또는 텍스트 레이어를 확인하세요.`);
    }
    if (derivedPdf) managementWarnings.push("OCR 결과/백업 PDF입니다. 문제 회차 관리는 원본 PDF 기준으로 진행하세요.");
  }
  if (/yes/i.test(info.encrypted)) qualityWarnings.push("암호화 PDF입니다. OCR 또는 텍스트 추출이 제한될 수 있습니다.");
  const percent = (value, expected) => expected ? Math.max(0, Math.min(100, Math.round((Number(value || 0) / expected) * 100))) : null;
  const questionDetectRate = expectedCount ? percent(labelStats.unique, expectedCount) : null;
  const choiceDetectRate = expectedChoiceCount ? percent(choiceLabels, expectedChoiceCount) : null;
  const hasOcrPatternWarning = qualityWarnings.some((item) => /OCR|문항번호|문항 수|선택지 기호|텍스트 레이어/.test(String(item || "")));
  const textStatusLabel = !qualityWarnings.length
    ? "정상"
    : (!compactText.length || hasOcrPatternWarning ? "OCR 확인" : "PDF 확인");
  const textStatusReason = qualityWarnings.length
    ? qualityWarnings.slice(0, 2).join(" / ")
    : "정상은 OCR 100%가 아니라 PDF 텍스트/구조 인식 기준 통과입니다.";
  const parsed = path.parse(abs);
  const defaultOcrAbs = path.join(parsed.dir, `${parsed.name.endsWith("_ocr") ? parsed.name : `${parsed.name}_ocr`}.pdf`);
  return {
    ok: true,
    path: rel,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    pages,
    pageSize: info.pageSize,
    encrypted: info.encrypted,
    textChars: compactText.length,
    docType,
    derivedPdf,
    originalCandidatePath,
    originalCandidateExists: originalCandidatePath ? manifestFileExists(originalCandidatePath) : false,
    koreanChars,
    alphaNumChars,
    charsPerPage,
    expectedChoiceCount,
    questionDetectRate,
    choiceDetectRate,
    textStatusLabel,
    textStatusReason,
    questionLabels,
    uniqueQuestionLabels: labelStats.unique,
    questionLabelMin: labelStats.min,
    questionLabelMax: labelStats.max,
    choiceLabels,
    choiceVariantLabels,
    brokenHangulRuns,
    answerPairs,
    expectedQuestionCount: expectedCount,
    matchedQuestionNo: questionMeta?.questionNo || "",
    matchedQuestionNm: questionMeta?.questionNm || "",
    needsOcr: qualityWarnings.length > 0,
    warnings: qualityWarnings,
    qualityWarnings,
    managementWarnings,
    textSample: text.replace(/\s+\n/g, "\n").trim().slice(0, 1200),
    textError,
    ocrCopyPath: fs.existsSync(defaultOcrAbs) ? toRel(defaultOcrAbs) : "",
    suggestedOcrPath: toRel(defaultOcrAbs),
  };
}

function nextBackupPath(abs){
  const parsed = path.parse(abs);
  let candidate = path.join(parsed.dir, `${parsed.name}_original${parsed.ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  candidate = path.join(parsed.dir, `${parsed.name}_original_${stamp}${parsed.ext}`);
  return candidate;
}

function nextRejectedOcrPath(abs){
  const parsed = path.parse(abs);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  let candidate = path.join(parsed.dir, `${parsed.name}_ocr_failed_${stamp}${parsed.ext}`);
  let seq = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}_ocr_failed_${stamp}_${seq}${parsed.ext}`);
    seq += 1;
  }
  return candidate;
}
// SOFTM-OCR: 품질 기준 미통과 OCR 결과는 원본을 덮지 않고 실패 산출물로 분리 보관 - 2026-05-30

async function handlePdfInfo(req, res, url){
  const relPath = url.searchParams.get("path") || "";
  sendJson(res, 200, await pdfDiagnostics(relPath));
}

function ocrStatusText(status){
  return {
    queued: "대기",
    running: "실행 중",
    canceling: "취소 중",
    canceled: "취소됨",
    completed: "완료",
    failed: "실패",
  }[status] || status;
}

function sanitizeOcrText(value){
  return String(value || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function appendOcrLog(job, chunk, stream){
  const text = sanitizeOcrText(chunk);
  job[stream] = `${job[stream] || ""}${text}`.slice(-40000);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines){
    job.logs.push(line);
    if (job.logs.length > ocrLogLimit) job.logs.shift();
    const percentMatch = line.match(/(\d{1,3})\s*%/);
    if (percentMatch) {
      job.progress = Math.max(job.progress || 0, Math.min(99, Number(percentMatch[1])));
      job.progressUpdatedMs = Date.now();
    }
    const pageMatch = line.match(/^(\d{1,4})\s+page is facing/i);
    if (pageMatch) {
      job.processedPages = Math.max(job.processedPages || 0, Number(pageMatch[1]));
      if (job.pageCount) {
        job.progress = Math.max(job.progress || 0, Math.min(80, Math.round((job.processedPages / job.pageCount) * 75)));
        job.progressUpdatedMs = Date.now();
      }
    }
    if (/Parsing\s+\d+\s+pages/i.test(line)) {
      job.progress = Math.max(job.progress || 0, 84);
      job.progressUpdatedMs = Date.now();
    }
    if (/Optimize|Linearizing|Postprocessing|Output file/i.test(line)) {
      job.progress = Math.max(job.progress || 0, 92);
      job.progressUpdatedMs = Date.now();
    }
    const fallbackPagesMatch = line.match(/^FALLBACK pages\s+(\d+)/i);
    if (fallbackPagesMatch) {
      job.pageCount = Number(fallbackPagesMatch[1]);
      job.progress = Math.max(job.progress || 0, 8);
      job.progressUpdatedMs = Date.now();
    }
    const fallbackPageMatch = line.match(/^FALLBACK page\s+(\d+)\/(\d+)/i);
    if (fallbackPageMatch) {
      job.processedPages = Math.max(job.processedPages || 0, Number(fallbackPageMatch[1]));
      job.pageCount = Number(fallbackPageMatch[2]) || job.pageCount;
      job.progress = Math.max(job.progress || 0, Math.min(88, Math.round((job.processedPages / job.pageCount) * 82)));
      job.progressUpdatedMs = Date.now();
    }
    if (/^FALLBACK merge/i.test(line)) {
      job.progress = Math.max(job.progress || 0, 92);
      job.progressUpdatedMs = Date.now();
    }
    if (/^FALLBACK done/i.test(line)) {
      job.progress = Math.max(job.progress || 0, 96);
      job.progressUpdatedMs = Date.now();
    }
  }
  job.updatedAt = new Date().toISOString();
}

function currentOcrProgress(job){
  let progress = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  let estimated = false;
  if ((job.status === "running" || job.status === "canceling") && progress < 84) {
    const elapsedMs = Math.max(0, Date.now() - job.startedMs);
    const estimatedTotalMs = Math.max(5 * 60 * 1000, (job.pageCount || 8) * ocrEstimateMsPerPage);
    const elapsedEstimate = Math.min(82, Math.max(2, Math.round((elapsedMs / estimatedTotalMs) * 82)));
    if (elapsedEstimate > progress) {
      progress = elapsedEstimate;
      estimated = true;
    }
  }
  return { progress, estimated };
}

function stopOcrProcess(job, signal = "SIGTERM"){
  if (!job?.pid) return;
  try{
    process.kill(-job.pid, signal);
    return;
  }catch(_){
    try{ process.kill(job.pid, signal); }catch(__){}
  }
}

function stopOcrPid(pid, signal = "SIGTERM"){
  const value = Number(pid || 0);
  if (!value) return false;
  try{
    process.kill(-value, signal);
    return true;
  }catch(_){
    try{
      process.kill(value, signal);
      return true;
    }catch(__){
      return false;
    }
  }
}

function commandIncludesPath(command, abs){
  if (!abs) return true;
  const raw = String(command || "");
  return raw.includes(abs) || raw.normalize("NFC").includes(abs.normalize("NFC")) || raw.normalize("NFD").includes(abs.normalize("NFD"));
}

function sameManagedRelPath(a, b){
  const left = stripManifestPrefix(a);
  const right = stripManifestPrefix(b);
  return left === right || left.normalize("NFC") === right.normalize("NFC") || left.normalize("NFD") === right.normalize("NFD");
}

async function findOcrProcessesForPath(relPath){
  const abs = relPath ? assertPdfManagedPath(relPath) : "";
  const { stdout } = await runCommand("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean)
    .filter((row) => row.command.includes("ocrmypdf"))
    .filter((row) => row.command.includes(root))
    .filter((row) => commandIncludesPath(row.command, abs));
}

async function stopOcrProcessesForPath(relPath){
  const rows = await findOcrProcessesForPath(relPath);
  for (const row of rows) stopOcrPid(row.pid, "SIGTERM");
  setTimeout(() => {
    findOcrProcessesForPath(relPath).then((remaining) => {
      for (const row of remaining) stopOcrPid(row.pid, "SIGKILL");
    }).catch(() => {});
  }, 5000);
  return rows;
}

function snapshotOcrJob(job){
  const currentProgress = currentOcrProgress(job);
  const waitingForLogs = (job.status === "running" || job.status === "canceling") && !job.processedPages;
  return {
    ok: true,
    id: job.id,
    status: job.status,
    statusText: ocrStatusText(job.status),
    progress: currentProgress.progress,
    progressEstimated: currentProgress.estimated,
    waitingForLogs,
    pageCount: job.pageCount || 0,
    processedPages: job.processedPages || 0,
    source: job.sourceRel,
    output: job.outputRel,
    backup: job.backupRel || "",
    pid: job.pid || 0,
    mode: job.ocrMode,
    engine: job.ocrEngine || "ocrmypdf",
    outputMode: job.outputMode,
    command: job.command,
    logs: job.logs.slice(-80),
    stdout: sanitizeOcrText(job.stdout).trim(),
    stderr: sanitizeOcrText(job.stderr).trim(),
    error: job.error || "",
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    lastProgressAt: job.progressUpdatedMs ? new Date(job.progressUpdatedMs).toISOString() : "",
    lastProgressAgeMs: job.progressUpdatedMs ? Date.now() - job.progressUpdatedMs : Date.now() - job.startedMs,
    endedAt: job.endedAt || "",
    elapsedMs: Date.now() - job.startedMs,
    result: job.result || null,
  };
}

function activeOcrJobForRel(relPath){
  const rel = stripManifestPrefix(relPath);
  return [...ocrJobs.values()].find((job) => {
    return ["running", "canceling"].includes(job.status) && sameManagedRelPath(job.sourceRel, rel);
  }) || null;
}

async function buildOcrJobConfig(body){
  const inputAbs = assertPdfManagedPath(body.path);
  if (isDerivedPdfPath(toRel(inputAbs))) {
    const original = originalCandidateForDerivedPdf(toRel(inputAbs));
    throw new Error(`OCR 결과/백업 PDF에는 다시 OCR을 적용할 수 없습니다. 원본 문제 PDF에서 실행하세요.${original ? ` 원본 후보: ${original}` : ""}`);
  }
  const outputMode = String(body.outputMode || "copy");
  const ocrMode = String(body.ocrMode || "redo");
  const ocrEngine = String(body.ocrEngine || "fallback");
  const sourceMeta = questionMetaForPdf(toRel(inputAbs));
  const sourceDiagnostics = await pdfDiagnostics(toRel(inputAbs), { meta: sourceMeta || undefined });
  if (ocrMode !== "force" && sourceDiagnostics && !sourceDiagnostics.needsOcr) {
    throw new Error("이미 OCR 텍스트 품질 기준을 통과했습니다. 기본 OCR은 원본보다 품질이 낮은 사본을 만들 수 있어 실행하지 않습니다. 반드시 필요하면 OCR 방식을 '전체 강제 OCR'로 바꾸세요.");
  }
  // SOFTM-OCR: OCR 품질 정상 원본은 기본 OCR 재실행을 차단해 저품질 사본 생성을 방지 - 2026-05-30
  const parsed = path.parse(inputAbs);
  const tool = await checkCommand("ocrmypdf");
  if (ocrEngine === "ocrmypdf" && !tool.ok) throw new Error("ocrmypdf를 찾을 수 없습니다. OCR 적용을 위해 ocrmypdf 설치가 필요합니다.");

  let flag = "--redo-ocr";
  if (ocrMode === "force") flag = "--force-ocr";
  if (ocrMode === "skip") flag = "--skip-text";

  const copyOutputAbs = path.join(parsed.dir, `${parsed.name.endsWith("_ocr") ? `${parsed.name}_fixed` : `${parsed.name}_ocr`}${parsed.ext}`);
  const tempOutputAbs = path.join(parsed.dir, `.${parsed.name}_ocr_${Date.now()}${parsed.ext}`);
  const outputAbs = outputMode === "replace" ? tempOutputAbs : copyOutputAbs;
  if (outputMode !== "replace" && fs.existsSync(outputAbs)) {
    await fsp.rm(outputAbs, { force: true });
  }
  let pageCount = 0;
  try{
    const infoRaw = (await runCommand("pdfinfo", [inputAbs], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    pageCount = Number(parsePdfInfoText(infoRaw).pages || 0);
  }catch(_){
    pageCount = 0;
  }

  if (ocrEngine === "fallback") {
    const fallbackTools = await Promise.all(["pdftoppm", "tesseract", "python3"].map((name) => checkCommand(name)));
    const missing = fallbackTools.filter((row) => !row.ok).map((row) => row.name);
    if (missing.length) throw new Error(`fallback OCR 도구가 없습니다: ${missing.join(", ")}`);
    return {
      inputAbs,
      outputAbs,
      outputMode,
      ocrMode,
      ocrEngine,
      commandName: process.execPath,
      args: [path.join(scriptDir, "ocr-fallback.mjs"), inputAbs, outputAbs],
      pageCount,
    };
  }

  const preprocessArgs = ocrMode === "redo" ? [] : ["--deskew"];
  const args = [
    "-v", "1",
    ...preprocessArgs,
    "--rotate-pages",
    "--optimize", "1",
    "--output-type", "pdf",
    "-l", "kor+eng",
    flag,
    inputAbs,
    outputAbs,
  ];
  // SOFTM-OCR: OCR 품질 기준을 통과한 원본은 기본 OCR 재실행을 막아 더 낮은 품질의 OCR 사본 생성을 방지 - 2026-05-30
  // SOFTM-OCR: ocrmypdf redo 모드는 deskew와 호환되지 않아 모드별 전처리 옵션을 분리 - 2026-05-30
  return { inputAbs, outputAbs, outputMode, ocrMode, ocrEngine, commandName: "ocrmypdf", args, pageCount };
}

async function finalizeOcrJob(job){
  let finalAbs = job.outputAbs;
  let backupRel = "";
  let replaced = false;
  let rejected = false;
  const sourceRel = toRel(job.inputAbs);
  const sourceMeta = questionMetaForPdf(sourceRel);
  let diagnostics = await pdfDiagnostics(toRel(job.outputAbs), { meta: sourceMeta || undefined });
  if (job.outputMode === "replace") {
    if (diagnostics.needsOcr) {
      const rejectedAbs = nextRejectedOcrPath(job.inputAbs);
      await fsp.rename(job.outputAbs, rejectedAbs);
      finalAbs = rejectedAbs;
      job.outputAbs = rejectedAbs;
      rejected = true;
      diagnostics = await pdfDiagnostics(toRel(finalAbs), { meta: sourceMeta || undefined });
    } else {
      const backupAbs = nextBackupPath(job.inputAbs);
      await fsp.rename(job.inputAbs, backupAbs);
      await fsp.rename(job.outputAbs, job.inputAbs);
      finalAbs = job.inputAbs;
      backupRel = toRel(backupAbs);
      replaced = true;
      diagnostics = await pdfDiagnostics(toRel(finalAbs), { meta: sourceMeta || undefined });
    }
  } else if (diagnostics.needsOcr) {
    const rejectedAbs = nextRejectedOcrPath(job.inputAbs);
    await fsp.rename(job.outputAbs, rejectedAbs);
    finalAbs = rejectedAbs;
    job.outputAbs = rejectedAbs;
    rejected = true;
    diagnostics = await pdfDiagnostics(toRel(finalAbs), { meta: sourceMeta || undefined });
  } else {
    finalAbs = job.outputAbs;
  }
  // SOFTM-OCR: 사본 생성 모드에서도 품질 미달 OCR은 _ocr.pdf로 남기지 않고 실패 산출물로 분리 - 2026-05-30
  job.backupRel = backupRel;
  job.result = {
    ok: true,
    source: toRel(job.inputAbs),
    output: toRel(finalAbs),
    backup: backupRel,
    replaced,
    rejected,
    mode: job.ocrMode,
    engine: job.ocrEngine || "fallback",
    outputMode: job.outputMode,
    stdout: sanitizeOcrText(job.stdout).trim(),
    stderr: sanitizeOcrText(job.stderr).trim(),
    diagnostics,
  };
  job.outputRel = toRel(finalAbs);
  appendOcrLog(job, `최종 OCR 산출물: ${job.result.output}`, "stdout");
  if (diagnostics.needsOcr) appendOcrLog(job, "OCR 품질 미달로 실패 산출물에 보관했습니다. 게시/풀이에는 원본 PDF를 사용하세요.", "stdout");
  return job.result;
}
// SOFTM-OCR: 원본 교체 모드는 OCR 결과 품질 진단 통과 후에만 실제 원본을 덮어쓰도록 보정 - 2026-05-30
// SOFTM-OCR: 엔진 임시 출력 경로와 최종 보관 경로를 분리해 OCR 실패 산출물이 _ocr.pdf 성공처럼 보이지 않게 표시 - 2026-05-30

async function startOcrJob(body){
  const inputAbs = assertPdfManagedPath(body.path);
  const sourceRel = toRel(inputAbs);
  const existingJob = activeOcrJobForRel(sourceRel);
  if (existingJob) {
    existingJob.reused = true;
    appendOcrLog(existingJob, "이미 실행 중인 OCR 작업에 연결했습니다.", "stdout");
    return existingJob;
  }
  const config = await buildOcrJobConfig(body);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const job = {
    id,
    status: "running",
    progress: 2,
    processedPages: 0,
    pageCount: config.pageCount,
    progressUpdatedMs: Date.now(),
    logs: [],
    stdout: "",
    stderr: "",
    startedAt,
    updatedAt: startedAt,
    startedMs: Date.now(),
    sourceRel: toRel(config.inputAbs),
    outputRel: toRel(config.outputAbs),
    inputAbs: config.inputAbs,
    outputAbs: config.outputAbs,
    outputMode: config.outputMode,
    ocrMode: config.ocrMode,
    ocrEngine: config.ocrEngine,
    reused: false,
    command: `${config.commandName} ${config.args.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(" ")}`,
  };
  ocrJobs.set(id, job);
  const child = spawn(config.commandName, config.args, { cwd: root, detached: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  job.child = child;
  job.pid = child.pid;
  appendOcrLog(job, `OCR 작업을 시작했습니다. PID ${child.pid || "-"}`, "stdout");
  child.stdout.on("data", (chunk) => appendOcrLog(job, chunk, "stdout"));
  child.stderr.on("data", (chunk) => appendOcrLog(job, chunk, "stderr"));
  child.on("error", (err) => {
    job.status = "failed";
    job.error = err?.message || String(err);
    job.endedAt = new Date().toISOString();
    job.updatedAt = job.endedAt;
  });
  const timeout = setTimeout(() => {
    if (job.status === "running") {
      job.status = "failed";
      job.error = `OCR 적용 시간이 ${Math.round(ocrTimeoutMs / 60000)}분을 초과해 중단했습니다.`;
      appendOcrLog(job, job.error, "stderr");
      stopOcrProcess(job);
    }
  }, ocrTimeoutMs);
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    (async () => {
      if (job.status === "canceling") {
        job.status = "canceled";
        job.progress = Math.min(job.progress || 0, 99);
        job.error = "사용자가 OCR 작업을 취소했습니다.";
        return;
      }
      if (job.status === "failed") return;
      if (code === 0) {
        job.progress = 96;
        await finalizeOcrJob(job);
        job.status = "completed";
        job.progress = 100;
      } else {
        job.status = "failed";
        job.error = `OCR 작업이 실패했습니다. 종료 코드 ${code ?? "-"}${signal ? `, signal ${signal}` : ""}`;
      }
    })().catch((err) => {
      job.status = "failed";
      job.error = err?.message || String(err);
    }).finally(() => {
      job.endedAt = new Date().toISOString();
      job.updatedAt = job.endedAt;
      delete job.child;
    });
  });
  return job;
}

async function handleOcrStart(req, res){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const job = await startOcrJob(body);
  const snapshot = snapshotOcrJob(job);
  snapshot.reused = Boolean(job.reused);
  sendJson(res, 200, snapshot);
}

async function handleOcrStatus(_req, res, url){
  const job = ocrJobs.get(url.searchParams.get("id") || "");
  if (!job) throw new Error("OCR 작업을 찾을 수 없습니다.");
  sendJson(res, 200, snapshotOcrJob(job));
}

async function handleOcrJobs(_req, res){
  sendJson(res, 200, { ok: true, jobs: [...ocrJobs.values()].map((job) => snapshotOcrJob(job)) });
}

async function handleOcrCancel(req, res, url){
  let id = url.searchParams.get("id") || "";
  let relPath = url.searchParams.get("path") || "";
  if (!id && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    id = String(body.id || "");
    relPath = String(body.path || relPath || "");
  }
  const job = id ? ocrJobs.get(id) : null;
  if (!job) {
    const killed = await stopOcrProcessesForPath(relPath);
    if (!killed.length) throw new Error("취소할 OCR 작업을 찾을 수 없습니다.");
    sendJson(res, 200, {
      ok: true,
      id: id || "",
      status: "canceled",
      statusText: "취소됨",
      progress: 0,
      orphanKilled: true,
    killed: killed.map((row) => ({ pid: row.pid, command: sanitizeOcrText(row.command).slice(0, 500) })),
      message: "서버 작업 ID 없이 실행 중이던 OCR 프로세스를 종료했습니다.",
    });
    return;
  }
  if (job.status === "running" && job.child) {
    job.status = "canceling";
    job.updatedAt = new Date().toISOString();
    stopOcrProcess(job);
    setTimeout(() => {
      if (job.status === "canceling" || job.status === "running") stopOcrProcess(job, "SIGKILL");
    }, 5000);
  } else if (job.status === "running") {
    await stopOcrProcessesForPath(job.sourceRel);
    job.status = "canceling";
    job.updatedAt = new Date().toISOString();
  }
  sendJson(res, 200, snapshotOcrJob(job));
}

async function handleOcr(req, res){
  return await handleOcrStart(req, res);
}
// SOFTM-OCR: OCR 적용을 백그라운드 작업으로 실행하고 진행률/로그/오류를 조회할 수 있도록 변경 - 2026-05-30
// SOFTM-OCR: ocrmypdf 중간 로그가 늦는 경우 추정 진행률과 작업 목록 조회를 제공 - 2026-05-30
// SOFTM-OCR: OCR 취소 시 프로세스 그룹 종료와 강제 종료 fallback 적용 - 2026-05-30
// SOFTM-OCR: 서버 재시작으로 작업 ID를 잃어도 PDF 경로 기준으로 남은 OCR 프로세스를 종료 - 2026-05-30
// SOFTM-OCR: 같은 PDF의 OCR 중복 실행을 막고 기존 작업에 연결 - 2026-05-30
// SOFTM-OCR: 한글 파일명 NFC/NFD 차이로 중복 OCR 작업이 생기지 않도록 경로 비교 보정 - 2026-05-30
// SOFTM-OCR: 기본 OCR 엔진을 워크스페이스 임시 파일 기반 fallback 파이프라인으로 전환 - 2026-05-30
/* SOFTM-OCR 끝 */

/* SOFTM-위치맵 시작: 위치맵 생성 작업 진행률 조회 API 추가 - 2026-06-02 */
const anchorJobs = new Map();
const anchorLogLimit = 160;
const anchorTimeoutMs = 10 * 60 * 1000;
const anchorEstimateMsPerPage = 12 * 1000;

function anchorStatusText(status){
  return {
    running: "실행 중",
    canceling: "취소 중",
    canceled: "취소됨",
    completed: "완료",
    failed: "실패",
  }[status] || status;
}

function appendAnchorLog(job, chunk, stream){
  const text = sanitizeOcrText(chunk);
  job[stream] = `${job[stream] || ""}${text}`.slice(-40000);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines){
    job.logs.push(line);
    if (job.logs.length > anchorLogLimit) job.logs.shift();
    if (/^ANCHOR render/i.test(line)) {
      job.progress = Math.max(job.progress || 0, 6);
      job.progressUpdatedMs = Date.now();
    }
    const pageMatch = line.match(/^ANCHOR page\s+(\d+)\/(\d+)/i);
    if (pageMatch) {
      job.processedPages = Math.max(job.processedPages || 0, Number(pageMatch[1]));
      job.pageCount = Number(pageMatch[2]) || job.pageCount;
      if (job.pageCount) {
        job.progress = Math.max(job.progress || 0, Math.min(88, 8 + Math.round((job.processedPages / job.pageCount) * 78)));
        job.progressUpdatedMs = Date.now();
      }
    }
    if (/^ANCHOR done/i.test(line)) {
      job.progress = Math.max(job.progress || 0, 94);
      job.progressUpdatedMs = Date.now();
    }
  }
  job.updatedAt = new Date().toISOString();
}

function currentAnchorProgress(job){
  let progress = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  let estimated = false;
  if ((job.status === "running" || job.status === "canceling") && progress < 84) {
    const elapsedMs = Math.max(0, Date.now() - job.startedMs);
    const estimatedTotalMs = Math.max(60 * 1000, (job.pageCount || 8) * anchorEstimateMsPerPage);
    const elapsedEstimate = Math.min(82, Math.max(2, Math.round((elapsedMs / estimatedTotalMs) * 82)));
    if (elapsedEstimate > progress) {
      progress = elapsedEstimate;
      estimated = true;
    }
  }
  return { progress, estimated };
}

function snapshotAnchorJob(job){
  const currentProgress = currentAnchorProgress(job);
  return {
    ok: true,
    id: job.id,
    status: job.status,
    statusText: anchorStatusText(job.status),
    progress: currentProgress.progress,
    progressEstimated: currentProgress.estimated,
    pageCount: job.pageCount || 0,
    processedPages: job.processedPages || 0,
    source: job.sourceRel,
    output: job.outputRel,
    pid: job.pid || 0,
    command: job.command,
    logs: job.logs.slice(-80),
    stdout: sanitizeOcrText(job.stdout).trim(),
    stderr: sanitizeOcrText(job.stderr).trim(),
    error: job.error || "",
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    lastProgressAt: job.progressUpdatedMs ? new Date(job.progressUpdatedMs).toISOString() : "",
    lastProgressAgeMs: job.progressUpdatedMs ? Date.now() - job.progressUpdatedMs : Date.now() - job.startedMs,
    endedAt: job.endedAt || "",
    elapsedMs: Date.now() - job.startedMs,
    result: job.result || null,
  };
}

function activeAnchorJobForRel(relPath){
  const rel = stripManifestPrefix(relPath);
  return [...anchorJobs.values()].find((job) => {
    return ["running", "canceling"].includes(job.status) && sameManagedRelPath(job.sourceRel, rel);
  }) || null;
}

async function buildAnchorJobConfig(body){
  const found = findQuestionManifestRow(body);
  const row = found.row;
  const questionPdfRel = stripManifestPrefix(row.questionPdf || body.path || "");
  const inputAbs = assertPdfManagedPath(questionPdfRel);
  if (isDerivedPdfPath(questionPdfRel)) throw new Error("문제·문항 위치맵은 원본 문제 PDF에서만 생성합니다.");
  const outputRel = anchorOutputRelForQuestion(row);
  const outputAbs = resolveWorkspacePath(outputRel);
  const questionCount = expectedQuestionCount(row);
  if (!questionCount) throw new Error("문항 수 정보가 없어 문제·문항 위치맵을 생성할 수 없습니다.");
  const choiceCount = Math.max(1, Math.min(5, Number(row.choiceCount || body.choiceCount || 4) || 4));
  const args = [
    path.join(scriptDir, "anchor-ocr.mjs"),
    "--input", inputAbs,
    "--output", outputAbs,
    "--question-no", String(row.questionNo || ""),
    "--question-count", String(questionCount),
    "--choice-count", String(choiceCount),
    "--question-pdf", questionPdfRel,
  ];
  if (row.questionStartNo) args.push("--question-start-no", String(row.questionStartNo));
  if (row.questionEndNo) args.push("--question-end-no", String(row.questionEndNo));
  let pageCount = 0;
  try{
    const infoRaw = (await runCommand("pdfinfo", [inputAbs], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    pageCount = Number(parsePdfInfoText(infoRaw).pages || 0);
  }catch(_){
    pageCount = 0;
  }
  return { found, row, inputAbs, outputAbs, outputRel, questionPdfRel, questionCount, choiceCount, args, pageCount };
}

async function finalizeAnchorJob(job){
  const anchorData = JSON.parse(await fsp.readFile(job.outputAbs, "utf8"));
  const fields = {
    anchorMap: `quiz/${job.outputRel}`,
    anchorStatus: Number(anchorData.confidence || 0) >= 0.32 ? "위치맵 생성" : "위치맵 확인 필요",
    anchorConfidence: Number(anchorData.confidence || 0),
    anchorWarnings: Array.isArray(anchorData.warnings) ? anchorData.warnings : [],
    anchorGeneratedAt: anchorData.generatedAt || new Date().toISOString(),
    questionStartNo: anchorData.questionStartNo || job.row.questionStartNo || "",
    questionEndNo: anchorData.questionEndNo || job.row.questionEndNo || "",
  };
  job.found.rows[job.found.index] = { ...job.found.rows[job.found.index], ...fields };
  await writeJsonFile(job.found.manifestName, job.found.rows);
  await updateCategoryQuestionManifest(job.row, fields);
  job.result = {
    ok: true,
    output: job.outputRel,
    manifestOutput: fields.anchorMap,
    status: fields.anchorStatus,
    confidence: fields.anchorConfidence,
    warnings: fields.anchorWarnings,
    detected: Array.isArray(anchorData.anchors) ? anchorData.anchors.length : 0,
    rawDetected: anchorData.rawAnchorCount || 0,
    pageCount: anchorData.pageCount || 0,
    questionCount: anchorData.questionCount || job.questionCount,
    choiceCount: anchorData.choiceCount || job.choiceCount,
    questionStartNo: anchorData.questionStartNo || "",
    questionEndNo: anchorData.questionEndNo || "",
    generatedAt: fields.anchorGeneratedAt,
    elapsedMs: Date.now() - job.startedMs,
    stdout: sanitizeOcrText(job.stdout).trim(),
    stderr: sanitizeOcrText(job.stderr).trim(),
  };
  return job.result;
}

async function startAnchorJob(body){
  const config = await buildAnchorJobConfig(body);
  const sourceRel = toRel(config.inputAbs);
  const existingJob = activeAnchorJobForRel(sourceRel);
  if (existingJob) {
    existingJob.reused = true;
    appendAnchorLog(existingJob, "이미 실행 중인 위치맵 생성 작업에 연결했습니다.", "stdout");
    return existingJob;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const job = {
    id,
    status: "running",
    progress: 2,
    processedPages: 0,
    pageCount: config.pageCount,
    progressUpdatedMs: Date.now(),
    logs: [],
    stdout: "",
    stderr: "",
    startedAt,
    updatedAt: startedAt,
    startedMs: Date.now(),
    sourceRel,
    outputRel: config.outputRel,
    inputAbs: config.inputAbs,
    outputAbs: config.outputAbs,
    found: config.found,
    row: config.row,
    questionCount: config.questionCount,
    choiceCount: config.choiceCount,
    reused: false,
    command: `${process.execPath} ${config.args.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(" ")}`,
  };
  anchorJobs.set(id, job);
  const child = spawn(process.execPath, config.args, { cwd: root, detached: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  job.child = child;
  job.pid = child.pid;
  appendAnchorLog(job, `위치맵 생성 작업을 시작했습니다. PID ${child.pid || "-"}`, "stdout");
  child.stdout.on("data", (chunk) => appendAnchorLog(job, chunk, "stdout"));
  child.stderr.on("data", (chunk) => appendAnchorLog(job, chunk, "stderr"));
  child.on("error", (err) => {
    job.status = "failed";
    job.error = err?.message || String(err);
    job.endedAt = new Date().toISOString();
    job.updatedAt = job.endedAt;
  });
  const timeout = setTimeout(() => {
    if (job.status === "running") {
      job.status = "failed";
      job.error = `위치맵 생성 시간이 ${Math.round(anchorTimeoutMs / 60000)}분을 초과해 중단했습니다.`;
      appendAnchorLog(job, job.error, "stderr");
      stopOcrProcess(job);
    }
  }, anchorTimeoutMs);
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    (async () => {
      if (job.status === "canceling") {
        job.status = "canceled";
        job.progress = Math.min(job.progress || 0, 99);
        job.error = "사용자가 위치맵 생성 작업을 취소했습니다.";
        return;
      }
      if (job.status === "failed") return;
      if (code === 0) {
        job.progress = 96;
        await finalizeAnchorJob(job);
        job.status = "completed";
        job.progress = 100;
      } else {
        job.status = "failed";
        job.error = `위치맵 생성 작업이 실패했습니다. 종료 코드 ${code ?? "-"}${signal ? `, signal ${signal}` : ""}`;
      }
    })().catch((err) => {
      job.status = "failed";
      job.error = err?.message || String(err);
    }).finally(() => {
      job.endedAt = new Date().toISOString();
      job.updatedAt = job.endedAt;
      delete job.child;
    });
  });
  return job;
}

async function handleAnchorOcrStart(req, res){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const job = await startAnchorJob(body);
  const snapshot = snapshotAnchorJob(job);
  snapshot.reused = Boolean(job.reused);
  sendJson(res, 200, snapshot);
}

async function handleAnchorOcrStatus(_req, res, url){
  const job = anchorJobs.get(url.searchParams.get("id") || "");
  if (!job) throw new Error("위치맵 생성 작업을 찾을 수 없습니다.");
  sendJson(res, 200, snapshotAnchorJob(job));
}

async function handleAnchorOcrJobs(_req, res){
  sendJson(res, 200, { ok: true, jobs: [...anchorJobs.values()].map((job) => snapshotAnchorJob(job)) });
}

async function handleAnchorOcrCancel(req, res, url){
  let id = url.searchParams.get("id") || "";
  const body = req.method === "POST" ? await readSmallJsonRequest(req).catch(() => ({})) : {};
  if (!id && body.id) id = String(body.id || "");
  let job = id ? anchorJobs.get(id) : null;
  if (!job && body.path) job = activeAnchorJobForRel(body.path);
  if (!job) {
    sendJson(res, 200, {
      ok: true,
      id: "",
      status: "canceled",
      statusText: "취소됨",
      progress: 100,
      message: "취소할 위치맵 생성 작업이 없습니다.",
    });
    return;
  }
  if (job.status === "running" && job.child) {
    job.status = "canceling";
    job.updatedAt = new Date().toISOString();
    stopOcrProcess(job);
    setTimeout(() => {
      if (job.status === "canceling" || job.status === "running") stopOcrProcess(job, "SIGKILL");
    }, 5000);
  }
  sendJson(res, 200, snapshotAnchorJob(job));
}
/* SOFTM-위치맵 끝 */

function anchorManifestName(dataset){
  return dataset === "knou" ? "knou_question.json" : "question.json";
}

function findQuestionManifestRow(body = {}){
  const dataset = String(body.dataset || "default") === "knou" ? "knou" : "default";
  const manifestName = anchorManifestName(dataset);
  const rows = readJsonFile(manifestName, []);
  const questionNo = String(body.questionNo || "");
  const targetPath = stripManifestPrefix(body.path || body.questionPdf || body.question || "");
  const list = Array.isArray(rows) ? rows : [];
  let index = targetPath
    ? list.findIndex((row) => sameManagedRelPath(row?.questionPdf || "", targetPath))
    : -1;
  if (index < 0 && questionNo) {
    index = list.findIndex((row) => String(row?.questionNo || "") === questionNo);
  }
  if (index < 0) throw new Error("문제·문항 위치맵을 생성할 회차를 question manifest에서 찾을 수 없습니다.");
  return { dataset, manifestName, rows, index, row: rows[index] };
}

function anchorOutputRelForQuestion(row){
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  if (!questionPdf) throw new Error("문제 PDF 경로가 없습니다.");
  const parsed = path.posix.parse(questionPdf);
  return path.posix.join(parsed.dir, `${parsed.name}_anchor.json`);
}

async function updateCategoryQuestionManifest(row, fields){
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  if (!questionPdf) return;
  const dirRel = path.posix.dirname(questionPdf);
  const localManifestAbs = resolveWorkspacePath(path.posix.join(dirRel, "question.json"));
  if (!fs.existsSync(localManifestAbs)) return;
  try{
    const localRows = JSON.parse(await fsp.readFile(localManifestAbs, "utf8"));
    if (!Array.isArray(localRows)) return;
    const idx = localRows.findIndex((item) => (
      (row?.questionNo && String(item?.questionNo || "") === String(row.questionNo))
      || sameManagedRelPath(item?.questionPdf || "", questionPdf)
    ));
    if (idx < 0) return;
    localRows[idx] = { ...localRows[idx], ...fields };
    await fsp.writeFile(localManifestAbs, `${JSON.stringify(localRows, null, 2)}\n`, "utf8");
  }catch(_){}
}

function correctJsonRelForQuestion(row){
  const explicit = stripManifestPrefix(row?.correctJson || "");
  if (explicit) return explicit;
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  if (!questionPdf) return "";
  return path.posix.join(path.posix.dirname(questionPdf), "correct.json");
}

function normalizeCorrectJsonRelPath(value){
  const rel = stripManifestPrefix(value);
  if (!rel || !rel.startsWith("pdf/") || path.posix.basename(rel) !== "correct.json") {
    throw new Error("정답 JSON은 pdf 하위의 correct.json만 삭제할 수 있습니다.");
  }
  return rel;
}

function correctItemMatchesQuestion(item, row){
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  const itemQuestionPdf = stripManifestPrefix(item?.questionPdf || "");
  if (questionPdf && itemQuestionPdf && sameManagedRelPath(itemQuestionPdf, questionPdf)) return true;
  const questionNo = String(row?.questionNo || "");
  const itemQuestionNo = String(item?.questionNo || "");
  if (!questionNo || !itemQuestionNo || questionNo !== itemQuestionNo) return false;
  return !questionPdf || !itemQuestionPdf || sameManagedRelPath(itemQuestionPdf, questionPdf);
}

function correctManifestClearFields(){
  return {
    correctJson: "",
    answerCount: "",
    answerStartNo: "",
    answerEndNo: "",
  };
}

function withCorrectManifestCleared(row){
  const next = { ...(row || {}), ...correctManifestClearFields() };
  delete next.printedAnswerNoMap;
  delete next.answerIndexMode;
  return next;
}

function formatAnswerArray(values, indent = 0, perLine = 10){
  const lines = ["["];
  if (values.length) {
    const pad = " ".repeat(indent + 2);
    const last = values.length - 1;
    for (let start = 0; start < values.length; start += perLine) {
      const chunk = [];
      for (let idx = start; idx < Math.min(start + perLine, values.length); idx += 1) {
        const raw = JSON.stringify(values[idx]);
        chunk.push(idx < last ? `${raw},` : raw);
      }
      lines.push(`${pad}${chunk.join(" ")}`);
    }
  }
  lines.push(`${" ".repeat(indent)}]`);
  return lines.join("\n");
}

function formatCorrectJsonValue(value, indent = 0, keyName = ""){
  if (keyName === "answers" && Array.isArray(value)) return formatAnswerArray(value, indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const lines = ["["];
    for (let idx = 0; idx < value.length; idx += 1) {
      const rendered = formatCorrectJsonValue(value[idx], indent + 2);
      lines.push(`${" ".repeat(indent + 2)}${rendered}${idx < value.length - 1 ? "," : ""}`);
    }
    lines.push(`${" ".repeat(indent)}]`);
    return lines.join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    const lines = ["{"];
    entries.forEach(([key, child], idx) => {
      const rendered = formatCorrectJsonValue(child, indent + 2, key);
      lines.push(`${" ".repeat(indent + 2)}${JSON.stringify(String(key))}: ${rendered}${idx < entries.length - 1 ? "," : ""}`);
    });
    lines.push(`${" ".repeat(indent)}}`);
    return lines.join("\n");
  }
  return JSON.stringify(value);
}

async function writeCorrectJsonFile(abs, payload){
  await fsp.writeFile(abs, `${formatCorrectJsonValue(payload)}\n`, "utf8");
}

async function clearCategoryQuestionManifestCorrectFields(row){
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  if (!questionPdf) return;
  const dirRel = path.posix.dirname(questionPdf);
  const localManifestAbs = resolveWorkspacePath(path.posix.join(dirRel, "question.json"));
  if (!fs.existsSync(localManifestAbs)) return;
  try{
    const localRows = JSON.parse(await fsp.readFile(localManifestAbs, "utf8"));
    if (!Array.isArray(localRows)) return;
    const idx = localRows.findIndex((item) => (
      (row?.questionNo && String(item?.questionNo || "") === String(row.questionNo))
      || sameManagedRelPath(item?.questionPdf || "", questionPdf)
    ));
    if (idx < 0) return;
    localRows[idx] = withCorrectManifestCleared(localRows[idx]);
    await fsp.writeFile(localManifestAbs, `${JSON.stringify(localRows, null, 2)}\n`, "utf8");
  }catch(_){}
}

const anchorManifestFieldKeys = ["anchorMap", "anchorStatus", "anchorConfidence", "anchorWarnings", "anchorGeneratedAt"];

function withoutAnchorManifestFields(row){
  const next = { ...(row || {}) };
  for (const key of anchorManifestFieldKeys) delete next[key];
  return next;
}

async function clearCategoryQuestionManifestAnchorFields(row){
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  if (!questionPdf) return;
  const dirRel = path.posix.dirname(questionPdf);
  const localManifestAbs = resolveWorkspacePath(path.posix.join(dirRel, "question.json"));
  if (!fs.existsSync(localManifestAbs)) return;
  try{
    const localRows = JSON.parse(await fsp.readFile(localManifestAbs, "utf8"));
    if (!Array.isArray(localRows)) return;
    const idx = localRows.findIndex((item) => (
      (row?.questionNo && String(item?.questionNo || "") === String(row.questionNo))
      || sameManagedRelPath(item?.questionPdf || "", questionPdf)
    ));
    if (idx < 0) return;
    localRows[idx] = withoutAnchorManifestFields(localRows[idx]);
    await fsp.writeFile(localManifestAbs, `${JSON.stringify(localRows, null, 2)}\n`, "utf8");
  }catch(_){}
}

async function handleAnchorOcr(req, res){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const found = findQuestionManifestRow(body);
  const row = found.row;
  const questionPdfRel = stripManifestPrefix(row.questionPdf || body.path || "");
  const inputAbs = assertPdfManagedPath(questionPdfRel);
  if (isDerivedPdfPath(questionPdfRel)) throw new Error("문제·문항 위치맵은 원본 문제 PDF에서만 생성합니다.");
  const outputRel = anchorOutputRelForQuestion(row);
  const outputAbs = resolveWorkspacePath(outputRel);
  const questionCount = expectedQuestionCount(row);
  if (!questionCount) throw new Error("문항 수 정보가 없어 문제·문항 위치맵을 생성할 수 없습니다.");
  const choiceCount = Math.max(1, Math.min(5, Number(row.choiceCount || body.choiceCount || 4) || 4));
  const args = [
    path.join(scriptDir, "anchor-ocr.mjs"),
    "--input", inputAbs,
    "--output", outputAbs,
    "--question-no", String(row.questionNo || ""),
    "--question-count", String(questionCount),
    "--choice-count", String(choiceCount),
    "--question-pdf", questionPdfRel,
  ];
  if (row.questionStartNo) args.push("--question-start-no", String(row.questionStartNo));
  if (row.questionEndNo) args.push("--question-end-no", String(row.questionEndNo));
  const started = Date.now();
  const result = await runCommand(process.execPath, args, { maxBuffer: 120 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const anchorData = JSON.parse(await fsp.readFile(outputAbs, "utf8"));
  const fields = {
    anchorMap: `quiz/${outputRel}`,
    anchorStatus: Number(anchorData.confidence || 0) >= 0.32 ? "위치맵 생성" : "위치맵 확인 필요",
    anchorConfidence: Number(anchorData.confidence || 0),
    anchorWarnings: Array.isArray(anchorData.warnings) ? anchorData.warnings : [],
    anchorGeneratedAt: anchorData.generatedAt || new Date().toISOString(),
    questionStartNo: anchorData.questionStartNo || row.questionStartNo || "",
    questionEndNo: anchorData.questionEndNo || row.questionEndNo || "",
  };
  found.rows[found.index] = { ...found.rows[found.index], ...fields };
  await writeJsonFile(found.manifestName, found.rows);
  await updateCategoryQuestionManifest(row, fields);
  sendJson(res, 200, {
    ok: true,
    output: outputRel,
    manifestOutput: fields.anchorMap,
    status: fields.anchorStatus,
    confidence: fields.anchorConfidence,
    warnings: fields.anchorWarnings,
    detected: Array.isArray(anchorData.anchors) ? anchorData.anchors.length : 0,
    rawDetected: anchorData.rawAnchorCount || 0,
    pageCount: anchorData.pageCount || 0,
    questionCount: anchorData.questionCount || questionCount,
    choiceCount: anchorData.choiceCount || choiceCount,
    questionStartNo: anchorData.questionStartNo || "",
    questionEndNo: anchorData.questionEndNo || "",
    generatedAt: fields.anchorGeneratedAt,
    elapsedMs: Date.now() - started,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}
// SOFTM-위치맵: 전체 OCR PDF 대신 문제 시작 위치와 선택지 위치를 JSON으로 저장하고 manifest에 anchorMap 참조를 연결 - 2026-05-30

async function handleAnchorDelete(req, res){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const found = findQuestionManifestRow(body);
  const row = found.row;
  const explicit = stripManifestPrefix(row.anchorMap || "");
  const inferred = anchorOutputRelForQuestion(row);
  const candidates = [...new Set([explicit, inferred].filter(Boolean))]
    .filter((rel) => rel.startsWith("pdf/") && /_anchor\.json$/i.test(rel));
  const deleted = [];
  for (const rel of candidates){
    try{
      const abs = resolveWorkspacePath(rel);
      if (fs.existsSync(abs)) {
        await fsp.unlink(abs);
        deleted.push(rel);
      }
    }catch(err){
      throw new Error(`위치맵 삭제 실패: ${rel} (${err?.message || err})`);
    }
  }
  const fields = {
    anchorMap: "",
    anchorStatus: "",
    anchorConfidence: "",
    anchorWarnings: [],
    anchorGeneratedAt: "",
  };
  found.rows[found.index] = { ...found.rows[found.index], ...fields };
  await writeJsonFile(found.manifestName, found.rows);
  await updateCategoryQuestionManifest(row, fields);
  sendJson(res, 200, {
    ok: true,
    deleted,
    manifestName: found.manifestName,
    questionNo: row.questionNo || "",
    message: deleted.length ? "위치맵을 삭제했습니다." : "삭제할 위치맵 파일은 없지만 manifest 연결은 제거했습니다.",
  });
}
// SOFTM-위치맵: 생성된 _anchor.json과 manifest 연결을 확인 후 삭제하는 관리자 API 추가 - 2026-06-01

async function handleQuestionResetInitial(req, res){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const found = findQuestionManifestRow(body);
  const row = found.row;
  const explicit = stripManifestPrefix(row.anchorMap || "");
  const inferred = anchorOutputRelForQuestion(row);
  const candidates = [...new Set([explicit, inferred].filter(Boolean))]
    .filter((rel) => rel.startsWith("pdf/") && /_anchor\.json$/i.test(rel));
  const deleted = [];
  for (const rel of candidates){
    try{
      const abs = resolveWorkspacePath(rel);
      if (fs.existsSync(abs)) {
        await fsp.unlink(abs);
        deleted.push(rel);
      }
    }catch(err){
      throw new Error(`위치맵 삭제 실패: ${rel} (${err?.message || err})`);
    }
  }
  const fields = {
    correctJson: "",
    anchorMap: "",
    anchorStatus: "",
    anchorConfidence: "",
    anchorWarnings: [],
    anchorGeneratedAt: "",
  };
  const cleared = {
    correctJson: stripManifestPrefix(row.correctJson || ""),
    anchorMap: explicit || inferred || "",
  };
  found.rows[found.index] = { ...found.rows[found.index], ...fields };
  await writeJsonFile(found.manifestName, found.rows);
  await updateCategoryQuestionManifest(row, fields);
  sendJson(res, 200, {
    ok: true,
    deleted,
    cleared,
    manifestName: found.manifestName,
    questionNo: row.questionNo || "",
    message: "회차를 처음 생성 직후 상태로 초기화했습니다. 원본 PDF와 정답 PDF 연결은 유지했습니다.",
  });
}
// SOFTM-ADMIN: 회차 상세에서 생성 산출물 연결을 제거하고 문서 생성 직후 상태로 되돌리는 초기화 API 추가 - 2026-06-02

async function processReport(){
  const questions = readJsonFile("question.json", []);
  const rawRows = Array.isArray(questions) ? questions : [];
  const catalog = await catalogState();
  const rows = catalog.questions.filter((row) => row.dataset === "default");
  const published = rows.filter((row) => row.published);
  const unpublished = rows.filter((row) => !row.published).map((row) => ({
    questionNo: row.questionNo || "",
    category: row.catNm || "",
    questionNm: row.questionNm || "",
    questionPdf: row.questionPdf || "",
    answerPdf: row.answerPdf || "",
    reason: row.issue && row.issue !== "정상" ? row.issue : (row.answerPdf ? "정답 파싱 또는 correct.json 생성 필요" : "정답 파일 매핑 필요"),
  }));
  const generatedFiles = [
    fileInfo("json/group.json"),
    fileInfo("json/category.json"),
    fileInfo("json/question.json"),
    ...walkManagedFiles("pdf").filter((file) => path.basename(file) === "question.json" || path.basename(file) === "correct.json").map((file) => fileInfo(toRel(file))),
  ].sort((a, b) => String(b.mtime || "").localeCompare(String(a.mtime || "")));
  const tools = await Promise.all([checkCommand("python3"), checkCommand("pdftotext"), checkCommand("pdfinfo"), checkCommand("ocrmypdf"), checkCommand("tesseract"), checkCommand("hwp5html")]);
  return {
    ok: true,
    files: processFileSummary(),
    manifest: {
      questions: rawRows.length,
      published: published.length,
      unpublished: unpublished.length,
    },
    scripts: ["gen_category.py", "gen_question.py", "gen_correct.py"].map(scriptInfo),
    tools,
    generatedFiles: generatedFiles.slice(0, 24),
    unpublished: unpublished.slice(0, 30),
    nextSteps: [
      "pdf 하위에 문제 PDF와 정답 PDF/HWP를 배치합니다.",
      "프로세스 점검에서 정답 매핑 누락 여부를 확인합니다.",
      "JSON 재생성을 실행합니다. 내부 순서는 gen_category.py → gen_question.py → gen_correct.py 입니다.",
      "기존 카테고리에 파일만 추가한 경우에는 카테고리 행의 JSON 갱신으로 해당 범위만 업데이트할 수 있습니다.",
      "미게시 회차가 0인지 확인하고 Git 상태를 확인합니다.",
    ],
  };
}
/* SOFTM-ADMIN 끝 */

function runGenerateManifest(){
  const scripts = ["gen_category.py", "gen_question.py", "gen_correct.py"];
  const runOne = (scriptName) => new Promise((resolve, reject) => {
    execFile("python3", [path.join(scriptDir, scriptName)], { cwd: root, maxBuffer: 80 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${scriptName} failed\n${stderr || stdout || err.message}`;
        reject(err);
        return;
      }
      resolve({ scriptName, stdout, stderr });
    });
  });
  return scripts.reduce((promise, scriptName) => (
    promise.then(async (results) => [...results, await runOne(scriptName)])
  ), Promise.resolve([]));
}

function normalizedRelKey(value){
  return stripManifestPrefix(value).normalize("NFC");
}

function nextPaddedNo(rows, key, width){
  let max = 0;
  for (const row of rows || []){
    const n = Number(row?.[key] || 0);
    if (Number.isFinite(n)) max = Math.max(max, Math.trunc(n));
  }
  return () => {
    max += 1;
    return String(max).padStart(width, "0");
  };
}

function isAnswerDirPath(abs){
  const pdfRoot = path.join(root, "pdf");
  const rel = path.relative(pdfRoot, abs);
  if (!rel || rel.startsWith("..")) return false;
  return rel.split(path.sep).some((part) => part.normalize("NFC") === "정답");
}

function scanPdfCategoryDirs(){
  const pdfRoot = path.join(root, "pdf");
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try{
      entries = fs.readdirSync(dir, { withFileTypes: true });
    }catch(_){
      return;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name.normalize("NFC") !== "정답")
      .sort((a, b) => a.name.normalize("NFC").localeCompare(b.name.normalize("NFC"), "ko"));
    for (const entry of dirs){
      const abs = path.join(dir, entry.name);
      if (isAnswerDirPath(abs)) continue;
      out.push(abs);
      walk(abs);
    }
  };
  walk(pdfRoot);
  return out.sort((a, b) => {
    const ar = path.relative(pdfRoot, a).split(path.sep).map((part) => part.normalize("NFC")).join("\u0000");
    const br = path.relative(pdfRoot, b).split(path.sep).map((part) => part.normalize("NFC")).join("\u0000");
    return ar.localeCompare(br, "ko");
  });
}

async function syncCategoryManifest(){
  const existingGroups = readJsonFile("group.json", []);
  const existingCategories = readJsonFile("category.json", []);
  const groupByName = new Map((Array.isArray(existingGroups) ? existingGroups : []).map((row) => [String(row?.gNm || "").normalize("NFC"), row]));
  const categoryByPath = new Map((Array.isArray(existingCategories) ? existingCategories : []).map((row) => [normalizedRelKey(row?.catPath || ""), row]));
  const nextGroupNo = nextPaddedNo(existingGroups, "gNo", 2);
  const nextCatNo = nextPaddedNo(existingCategories, "catNo", 4);
  const dirs = scanPdfCategoryDirs();
  const groups = [];
  const categories = [];
  const rootToGroup = new Map();
  const dirToCat = new Map();
  const seenGroupNames = new Set();
  let addedCategories = 0;
  let addedGroups = 0;

  for (const abs of dirs){
    const relFromPdf = path.relative(path.join(root, "pdf"), abs).split(path.sep);
    const rootName = String(relFromPdf[0] || "").normalize("NFC");
    if (!rootToGroup.has(rootName)) {
      let group = groupByName.get(rootName);
      if (!group) {
        group = { gNo: nextGroupNo(), gNm: rootName };
        addedGroups += 1;
      }
      const normalizedGroup = {
        gNo: String(group.gNo || nextGroupNo()),
        gNm: rootName,
        seq: groups.length + 1,
      };
      rootToGroup.set(rootName, normalizedGroup);
      groups.push(normalizedGroup);
      seenGroupNames.add(rootName);
    }
    const catPath = `quiz/${toRel(abs)}`;
    const existing = categoryByPath.get(normalizedRelKey(catPath));
    const parentCatNo = dirToCat.get(path.dirname(abs)) || "";
    let catNo = existing?.catNo ? String(existing.catNo) : "";
    if (!catNo) {
      catNo = nextCatNo();
      addedCategories += 1;
    }
    const row = {
      gNo: rootToGroup.get(rootName).gNo,
      gNm: rootName,
      catNm: path.basename(abs).normalize("NFC"),
      catNo,
      parentCatNo,
      catPath,
      depth: relFromPdf.length,
      seq: categories.length + 1,
    };
    dirToCat.set(abs, catNo);
    categories.push(row);
  }

  const previousCategoryCount = Array.isArray(existingCategories) ? existingCategories.length : 0;
  await writeJsonFile("group.json", groups);
  await writeJsonFile("category.json", categories);
  return {
    ok: true,
    groups: groups.length,
    categories: categories.length,
    addedGroups,
    addedCategories,
    removedCategories: Math.max(0, previousCategoryCount - categories.length + addedCategories),
  };
}
// SOFTM-GEN: 새 pdf 디렉토리를 기존 catNo/gNo 보존 방식으로 category.json에 반영 - 2026-06-01

function resolveRebuildCategory(body){
  const dataset = String(body.dataset || "default");
  if (dataset !== "default") {
    throw new Error("카테고리 단위 JSON 갱신은 현재 기본 PDF 문제은행만 지원합니다. 방통대 별도 manifest는 전체 재생성 또는 import 흐름을 사용하세요.");
  }
  const categories = readJsonFile("category.json", []);
  const catNo = String(body.catNo || "");
  const requestedPath = stripManifestPrefix(body.categoryPath || "");
  const row = (Array.isArray(categories) ? categories : []).find((item) => (
    (catNo && String(item?.catNo || "") === catNo)
    || (requestedPath && stripManifestPrefix(item?.catPath || "") === requestedPath)
  ));
  if (!row) throw new Error("선택한 카테고리를 json/category.json에서 찾을 수 없습니다. 새 카테고리는 전체 JSON 재생성을 먼저 실행하세요.");
  const categoryPath = stripManifestPrefix(row.catPath || requestedPath);
  if (!categoryPath) throw new Error("선택한 카테고리의 catPath가 없습니다.");
  assertManagedPath(categoryPath);
  return { category: row, categoryPath };
}

function runGenerateCategoryManifest(body){
  const { category, categoryPath } = resolveRebuildCategory(body || {});
  const scripts = [
    { scriptName: "gen_question.py", args: ["--category-path", categoryPath] },
    { scriptName: "gen_correct.py", args: ["--category-path", categoryPath] },
  ];
  const runOne = ({ scriptName, args }) => new Promise((resolve, reject) => {
    execFile("python3", [path.join(scriptDir, scriptName), ...args], { cwd: root, maxBuffer: 80 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${scriptName} failed\n${stderr || stdout || err.message}`;
        reject(err);
        return;
      }
      resolve({ scriptName, stdout, stderr, args });
    });
  });
  return scripts.reduce((promise, script) => (
    promise.then(async (results) => [...results, await runOne(script)])
  ), Promise.resolve([])).then((results) => ({ category, categoryPath, results }));
}
// SOFTM-GEN: 선택 카테고리만 question/correct JSON을 갱신하는 관리자 재생성 흐름 추가 - 2026-05-30

function parseLastJsonLine(output){
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1){
    if (!lines[i].startsWith("{")) continue;
    try{
      return JSON.parse(lines[i]);
    }catch(_){}
  }
  return {};
}

async function handleCorrectGenerate(req, res){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const found = findQuestionManifestRow(body);
  const row = found.row;
  const questionNo = String(row?.questionNo || "");
  const questionPdf = stripManifestPrefix(row?.questionPdf || "");
  const answerPdf = stripManifestPrefix(row?.answerPdf || "");
  if (!questionPdf) throw new Error("문제 PDF 경로가 없습니다.");
  if (!answerPdf) throw new Error("정답 원본 파일이 연결되지 않았습니다.");
  if (!manifestFileExists(answerPdf)) throw new Error(`정답 원본 파일을 찾을 수 없습니다: ${answerPdf}`);

  const scriptPath = path.join(scriptDir, "gen_correct_one.py");
  const args = [
    scriptPath,
    "--manifest",
    found.manifestName,
    "--question-no",
    questionNo,
    "--question-pdf",
    questionPdf,
  ];
  const result = await new Promise((resolve, reject) => {
    execFile("python3", args, { cwd: root, maxBuffer: 80 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = stderr || stdout || err.message;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  const parsed = parseLastJsonLine(result.stdout);
  const refreshed = findQuestionManifestRow({ dataset: found.dataset, questionNo, path: questionPdf });
  const correctJson = stripManifestPrefix(refreshed.row?.correctJson || parsed.correctJson || "");
  const count = Number(refreshed.row?.answerCount || parsed.count || 0);
  sendJson(res, 200, {
    ok: true,
    questionNo,
    questionNm: refreshed.row?.questionNm || row?.questionNm || "",
    answerPdf,
    correctJson,
    count,
    itemAction: parsed.itemAction || "",
    manifestName: found.manifestName,
    output: String(result.stdout || "").trim(),
    errorOutput: String(result.stderr || "").trim(),
    message: correctJson ? `정답 JSON을 생성하고 회차에 연결했습니다(${count}개).` : "정답 JSON 생성은 끝났지만 연결 상태를 확인하지 못했습니다.",
  });
}
// SOFTM-GEN: 회차 상세에서 현재 회차 하나만 correct.json에 추가/교체하는 관리자 API 추가 - 2026-06-15

async function handleCorrectDelete(req, res){
  const body = await readSmallJsonRequest(req);
  const found = findQuestionManifestRow(body);
  const row = found.row;
  const correctRel = normalizeCorrectJsonRelPath(correctJsonRelForQuestion(row));
  const correctAbs = await resolveExistingWorkspacePath(correctRel);
  let beforeCount = 0;
  let afterCount = 0;
  let itemDeleted = false;
  let fileDeleted = false;

  if (fs.existsSync(correctAbs)) {
    const payload = JSON.parse(await fsp.readFile(correctAbs, "utf8"));
    const items = Array.isArray(payload?.items) ? payload.items : null;
    if (!items) throw new Error("correct.json items 배열을 찾을 수 없습니다.");
    beforeCount = items.length;
    const nextItems = items.filter((item) => !correctItemMatchesQuestion(item, row));
    afterCount = nextItems.length;
    itemDeleted = nextItems.length !== items.length;
    if (itemDeleted) {
      if (nextItems.length) {
        await writeCorrectJsonFile(correctAbs, { ...payload, items: nextItems });
      } else {
        await fsp.unlink(correctAbs);
        fileDeleted = true;
      }
    }
  } else if (!row?.correctJson) {
    throw new Error("삭제할 정답 JSON 파일이 없습니다.");
  }

  found.rows[found.index] = withCorrectManifestCleared(found.rows[found.index]);
  await writeJsonFile(found.manifestName, found.rows);
  await clearCategoryQuestionManifestCorrectFields(row);
  sendJson(res, 200, {
    ok: true,
    questionNo: row.questionNo || "",
    questionNm: row.questionNm || "",
    correctJson: correctRel,
    itemDeleted,
    fileDeleted,
    beforeCount,
    afterCount,
    manifestName: found.manifestName,
    message: itemDeleted
      ? "공유 correct.json에서 현재 회차 정답 항목을 삭제하고 연결을 해제했습니다."
      : "correct.json에서 현재 회차 항목은 찾지 못했지만 manifest 연결은 해제했습니다.",
  });
}
// SOFTM-GEN: 공유 correct.json에서 현재 회차 항목만 제거하고 manifest 연결을 해제하는 API 추가 - 2026-06-15

function pushArg(args, flag, value){
  const raw = String(value || "").trim();
  if (raw) args.push(flag, raw);
}

async function handleUpload(req, res){
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const file = files.find((item) => item.field === "file");
  if (!file) throw new Error("업로드 파일이 없습니다.");
  const mode = String(fields.mode || "direct");
  const originalName = file.fileName || "upload.bin";

  if (mode === "direct") {
    const dir = normalizeRelPath(fields.targetDir || "pdf/업로드");
    const safeName = path.basename(String(fields.targetName || originalName).trim() || originalName);
    const targetDir = assertManagedPath(dir);
    const targetPath = path.join(targetDir, safeName);
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(targetPath, file.content);
    sendJson(res, 200, { ok: true, mode, file: toRel(targetPath) });
    return;
  }

  const tempDir = path.join(root, ".admin_uploads");
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${Date.now()}_${path.basename(originalName)}`);
  await fsp.writeFile(tempPath, file.content);
  try{
    const args = [];
    if (mode === "knou-answer") args.push("--answer", tempPath);
    else if (mode === "knou-question") args.push("--question", tempPath);
    else throw new Error("알 수 없는 업로드 모드입니다.");
    pushArg(args, "--year", fields.year);
    pushArg(args, "--semester", fields.semester);
    pushArg(args, "--exam-type", fields.examType);
    pushArg(args, "--scope", fields.scope);
    pushArg(args, "--course", fields.course);
    pushArg(args, "--department", fields.department);
    pushArg(args, "--answer-source-id", fields.answerSourceId);
    pushArg(args, "--grade", fields.grade);
    pushArg(args, "--question-count", fields.questionCount);
    const result = await runImport(args);
    sendJson(res, 200, { ok: true, mode, output: result.stdout, errorOutput: result.stderr });
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function handleJsonAction(req, res, action){
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  if (action === "mkdir") {
    const target = assertManagedPath(body.dir);
    await fsp.mkdir(target, { recursive: true });
    sendJson(res, 200, { ok: true, dir: toRel(target) });
    return;
  }
  if (action === "rename") {
    const from = assertManagedPath(body.from);
    const to = assertManagedPath(body.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    sendJson(res, 200, { ok: true, from: toRel(from), to: toRel(to) });
    return;
  }
  sendJson(res, 404, { ok: false, message: "unknown action" });
}

async function serveFile(res, filePath){
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function serveStatic(req, res, url){
  const rel = normalizeRelPath(decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname));
  const filePath = await resolveExistingWorkspacePath(rel);
  let stat;
  try{
    stat = await fsp.stat(filePath);
  }catch(_){
    sendText(res, 404, "not found");
    return;
  }
  if (stat.isDirectory()) {
    const indexPath = path.join(filePath, "index.html");
    try{
      await fsp.access(indexPath);
      await serveFile(res, indexPath);
    }catch(_){
      sendText(res, 403, "directory listing disabled");
    }
    return;
  }
  await serveFile(res, filePath);
}

async function handleAdminDownload(req, res, url){
  const rel = stripManifestPrefix(url.searchParams.get("path") || "");
  if (!rel) throw new Error("다운로드할 파일 경로가 없습니다.");
  const filePath = await assertExistingManagedPath(rel);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error("파일만 다운로드할 수 있습니다.");
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "content-length": stat.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(base)}`,
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function escapeHtmlPreview(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractHtmlPart(html, tagName){
  const match = String(html || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? match[1] : "";
}

function buildHwpPreviewHtml(html, title = "HWP 문서"){
  const htmlText = String(html || "");
  const headContent = extractHtmlPart(htmlText, "head");
  const bodyContent = extractHtmlPart(htmlText, "body") || htmlText;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtmlPreview(title)}</title>
${headContent}
<style>
:root {
  --hwp-bg: #edf2f7;
  --hwp-panel: #ffffff;
  --hwp-ink: #1f2933;
  --hwp-muted: #66727f;
  --hwp-line: #d8e0e6;
  --hwp-accent: #256d7b;
}
html,
body {
  width: 100%;
  min-height: 100%;
  margin: 0;
  padding: 0;
  background: var(--hwp-bg);
  overflow: auto;
}
body {
  box-sizing: border-box;
  font-family: "Pretendard", "SUIT", "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--hwp-ink);
}
.hwp-preview-shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}
.hwp-preview-toolbar {
  position: sticky;
  top: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--hwp-line);
  background: rgba(244, 247, 251, 0.92);
  backdrop-filter: blur(10px);
}
.hwp-preview-toolbar button {
  min-width: 38px;
  height: 36px;
  border: 1px solid #c8d3e2;
  border-radius: 9px;
  background: #fff;
  color: var(--hwp-ink);
  font-size: 15px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.hwp-preview-toolbar button:hover {
  border-color: var(--hwp-accent);
  color: var(--hwp-accent);
}
.hwp-preview-toolbar button:active {
  transform: translateY(1px);
}
.hwp-zoom-label {
  min-width: 58px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--hwp-line);
  border-radius: 9px;
  background: var(--hwp-panel);
  color: var(--hwp-muted);
  font-size: 13px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.hwp-preview-stage {
  overflow: auto;
  padding: 18px;
}
.hwp-viewer-root {
  width: max-content;
  min-width: 0;
  margin: 0 auto;
  transform-origin: top center;
}
.hwp-viewer-root *,
.hwp-viewer-root *::before,
.hwp-viewer-root *::after {
  box-sizing: border-box;
}
.hwp-viewer-root > * {
  margin-left: auto !important;
  margin-right: auto !important;
}
.hwp-viewer-root [class*="page"],
.hwp-viewer-root [class*="Page"],
.hwp-viewer-root [class*="paper"],
.hwp-viewer-root [class*="Paper"] {
  background: #fff;
  box-shadow: 0 1px 8px rgba(15, 23, 42, 0.14);
}
.hwp-viewer-root img,
.hwp-viewer-root svg,
.hwp-viewer-root canvas {
  max-width: 100%;
  height: auto;
}
</style>
</head>
<body>
<div class="hwp-preview-shell">
  <div class="hwp-preview-toolbar" aria-label="HWP 미리보기 확대 축소">
    <button type="button" id="hwpZoomOut" title="축소" aria-label="축소">−</button>
    <span class="hwp-zoom-label" id="hwpZoomLabel">100%</span>
    <button type="button" id="hwpZoomIn" title="확대" aria-label="확대">＋</button>
    <button type="button" id="hwpZoomReset" title="원래대로" aria-label="원래대로">↺</button>
  </div>
  <div class="hwp-preview-stage">
    <div class="hwp-viewer-root" id="hwpViewerRoot">${bodyContent}</div>
  </div>
</div>
<script>
(function(){
  var root = document.getElementById("hwpViewerRoot");
  var label = document.getElementById("hwpZoomLabel");
  var zoomIn = document.getElementById("hwpZoomIn");
  var zoomOut = document.getElementById("hwpZoomOut");
  var zoomReset = document.getElementById("hwpZoomReset");
  var scale = 1;
  function clamp(value){
    return Math.max(0.5, Math.min(2.2, value));
  }
  function applyZoom(next){
    scale = clamp(next);
    if (root) root.style.zoom = String(scale);
    if (label) label.textContent = Math.round(scale * 100) + "%";
  }
  if (zoomIn) zoomIn.addEventListener("click", function(){ applyZoom(scale + 0.1); });
  if (zoomOut) zoomOut.addEventListener("click", function(){ applyZoom(scale - 0.1); });
  if (zoomReset) zoomReset.addEventListener("click", function(){ applyZoom(1); });
  document.addEventListener("keydown", function(event){
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyZoom(scale + 0.1);
    } else if (event.key === "-") {
      event.preventDefault();
      applyZoom(scale - 0.1);
    } else if (event.key === "0") {
      event.preventDefault();
      applyZoom(1);
    }
  });
  applyZoom(1);
})();
</script>
</body>
</html>`;
}

function buildHwpPreviewErrorHtml(message, relPath = ""){
  const downloadHref = relPath ? `/api/admin/download?path=${encodeURIComponent(relPath)}` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
body{margin:0;padding:24px;background:#f8fafc;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.box{max-width:720px;margin:40px auto;padding:24px;border:1px solid #dbe3ef;border-radius:18px;background:#fff;box-shadow:0 12px 32px rgba(15,23,42,.08)}
h1{margin:0 0 12px;font-size:22px}
p{line-height:1.65;color:#5b6878}
a{display:inline-flex;margin-top:10px;padding:10px 14px;border-radius:12px;background:#287987;color:white;text-decoration:none;font-weight:800}
</style>
</head>
<body>
<div class="box">
<h1>HWP 미리보기를 열 수 없습니다.</h1>
<p>${escapeHtmlPreview(message)}</p>
${downloadHref ? `<a href="${downloadHref}">원본 다운로드</a>` : ""}
</div>
</body>
</html>`;
}

function hwp5html(filePath){
  return new Promise((resolve, reject) => {
    execFile("hwp5html", ["--html", filePath], { cwd: root, maxBuffer: 120 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = stderr || stdout || err.message;
        reject(err);
        return;
      }
      resolve(stdout || "");
    });
  });
}

function simplifyHwpHtmlForViewer(html, title = "HWP 문서"){
  const htmlText = String(html || "");
  let bodyContent = extractHtmlPart(htmlText, "body") || htmlText;
  bodyContent = bodyContent
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/gi, "")
    .replace(/<col\b[^>]*\/?>/gi, "")
    .replace(/<(\/?)span\b[^>]*>/gi, "")
    .replace(/<p\b[^>]*>/gi, "<div>")
    .replace(/<\/p>/gi, "</div>")
    .replace(/<div\b[^>]*>/gi, "<div>")
    .replace(/\s(?:class|style|id|width|height|valign|align|border|cellspacing|cellpadding)="[^"]*"/gi, "")
    .replace(/\s(?:class|style|id|width|height|valign|align|border|cellspacing|cellpadding)=[^\s>]+/gi, "")
    .replace(/&#13;|&#10;/g, "")
    .replace(/<div>\s*<\/div>/gi, "")
    .replace(/>\s+</g, "><");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtmlPreview(title)}</title>
<style>
html,body{margin:0;padding:0;background:#f8fafc;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{padding:18px}
.hwp-simple-root{max-width:1180px;margin:0 auto}
.hwp-simple-title{margin:0 0 14px;font-size:18px;font-weight:900;color:#1f2937}
table{width:100%;border-collapse:collapse;margin:10px 0 18px;background:#fff;table-layout:auto}
td,th{border:1px solid #cbd5e1;padding:5px 7px;vertical-align:middle;font-size:13px;line-height:1.45;word-break:keep-all}
th{background:#eef2f7;font-weight:900}
div{min-height:1em}
</style>
</head>
<body>
<div class="hwp-simple-root">
<h1 class="hwp-simple-title">${escapeHtmlPreview(title)}</h1>
${bodyContent}
</div>
</body>
</html>`;
}

const hwpHtmlCache = new Map();

async function hwp5htmlCached(filePath, stat){
  const key = `${filePath}:${Number(stat?.mtimeMs || 0)}:${Number(stat?.size || 0)}`;
  const cached = hwpHtmlCache.get(key);
  if (cached?.html) return cached.html;
  if (cached?.promise) return await cached.promise;
  const promise = hwp5html(filePath)
    .then((html) => {
      hwpHtmlCache.clear();
      hwpHtmlCache.set(key, { html });
      return html;
    })
    .catch((err) => {
      hwpHtmlCache.delete(key);
      throw err;
    });
  hwpHtmlCache.set(key, { promise });
  return await promise;
}

async function handleHwpHtml(req, res, url){
  const rel = stripManifestPrefix(url.searchParams.get("path") || "");
  if (!rel) throw new Error("HWP 파일 경로가 없습니다.");
  const filePath = await assertExistingManagedPath(rel);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error("파일만 미리보기할 수 있습니다.");
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".hwp") throw new Error("현재 HWP 미리보기는 .hwp 파일만 지원합니다.");
  const html = await hwp5htmlCached(filePath, stat);
  if (!String(html || "").trim()) throw new Error("hwp5html 변환 결과가 비어 있습니다.");
  sendHtml(res, 200, simplifyHwpHtmlForViewer(html, path.basename(filePath)));
}

async function handleHwpPreview(req, res, url){
  const rel = stripManifestPrefix(url.searchParams.get("path") || "");
  if (!rel) {
    sendHtml(res, 400, buildHwpPreviewErrorHtml("HWP 파일 경로가 없습니다."));
    return;
  }
  let filePath;
  try{
    filePath = await assertExistingManagedPath(rel);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("파일만 미리보기할 수 있습니다.");
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".hwp") throw new Error("현재 HWP 미리보기는 .hwp 파일만 지원합니다.");
    const html = await hwp5htmlCached(filePath, stat);
    if (!html.trim()) throw new Error("hwp5html 변환 결과가 비어 있습니다.");
    sendHtml(res, 200, buildHwpPreviewHtml(html, path.basename(filePath)));
  }catch(err){
    sendHtml(res, 200, buildHwpPreviewErrorHtml(err?.message || String(err), rel));
  }
}

const server = http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/admin/")) {
      res.writeHead(204, adminCorsHeaders());
      res.end();
      return;
    }
    if (url.pathname === "/api/admin/state") return sendJson(res, 200, await manifestState());
    if (url.pathname === "/api/admin/catalog") return sendJson(res, 200, await catalogState());
    if (url.pathname === "/api/admin/process-report") return sendJson(res, 200, await processReport());
    if (url.pathname === "/api/admin/question-changes") return sendJson(res, 200, await questionChangesReport(url));
    if (url.pathname === "/api/admin/pdf-info") return await handlePdfInfo(req, res, url);
    if (url.pathname === "/api/admin/ocr/start" && req.method === "POST") return await handleOcrStart(req, res);
    if (url.pathname === "/api/admin/ocr/status") return await handleOcrStatus(req, res, url);
    if (url.pathname === "/api/admin/ocr/jobs") return await handleOcrJobs(req, res);
    if (url.pathname === "/api/admin/ocr/cancel" && req.method === "POST") return await handleOcrCancel(req, res, url);
    if (url.pathname === "/api/admin/ocr" && req.method === "POST") return await handleOcr(req, res);
    if (url.pathname === "/api/admin/anchor-data") return await handleAnchorData(req, res, url);
    if (url.pathname === "/api/admin/anchor-manual" && req.method === "POST") return await handleAnchorManualSave(req, res);
    if (url.pathname === "/api/admin/anchor-manual-delete" && req.method === "POST") return await handleAnchorManualDelete(req, res);
    if (url.pathname === "/api/admin/anchor-ocr/start" && req.method === "POST") return await handleAnchorOcrStart(req, res);
    if (url.pathname === "/api/admin/anchor-ocr/status") return await handleAnchorOcrStatus(req, res, url);
    if (url.pathname === "/api/admin/anchor-ocr/jobs") return await handleAnchorOcrJobs(req, res);
    if (url.pathname === "/api/admin/anchor-ocr/cancel" && req.method === "POST") return await handleAnchorOcrCancel(req, res, url);
    if (url.pathname === "/api/admin/anchor-ocr" && req.method === "POST") return await handleAnchorOcr(req, res);
    if (url.pathname === "/api/admin/anchor-delete" && req.method === "POST") return await handleAnchorDelete(req, res);
    if (url.pathname === "/api/admin/question-reset" && req.method === "POST") return await handleQuestionResetInitial(req, res);
    if (url.pathname === "/api/admin/correct-generate" && req.method === "POST") return await handleCorrectGenerate(req, res);
    if (url.pathname === "/api/admin/correct-delete" && req.method === "POST") return await handleCorrectDelete(req, res);
    if (url.pathname === "/api/admin/download") return await handleAdminDownload(req, res, url);
    if (url.pathname === "/api/admin/hwp-html") return await handleHwpHtml(req, res, url);
    if (url.pathname === "/api/admin/hwp-preview") return await handleHwpPreview(req, res, url);
    if (url.pathname === "/api/admin/git-status") return sendJson(res, 200, await gitStatus());
    if (url.pathname === "/api/admin/rebuild" && req.method === "POST") {
      const results = await runGenerateManifest();
      return sendJson(res, 200, { ok: true, output: results.map((row) => `$ ${row.scriptName}\n${row.stdout}${row.stderr || ""}`).join("\n") });
    }
    if (url.pathname === "/api/admin/sync-categories" && req.method === "POST") {
      return sendJson(res, 200, await syncCategoryManifest());
    }
    if (url.pathname === "/api/admin/rebuild-category" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const data = await runGenerateCategoryManifest(body);
      const output = data.results.map((row) => `$ ${row.scriptName} ${row.args.join(" ")}\n${row.stdout}${row.stderr || ""}`).join("\n");
      return sendJson(res, 200, {
        ok: true,
        category: data.category,
        categoryPath: data.categoryPath,
        output,
      });
    }
    // SOFTM-GEN: 전체 재생성과 별도로 선택 카테고리 JSON 갱신 API 추가 - 2026-05-30
    // SOFTM-위치맵: 상세 관리자에서 문제·문항 위치맵 JSON을 생성하는 API 추가 - 2026-05-30
    if (url.pathname === "/api/admin/list") return sendJson(res, 200, listDir(url.searchParams.get("dir") || "pdf"));
    if (url.pathname === "/api/admin/upload" && req.method === "POST") return await handleUpload(req, res);
    if (url.pathname === "/api/admin/mkdir" && req.method === "POST") return await handleJsonAction(req, res, "mkdir");
    if (url.pathname === "/api/admin/rename" && req.method === "POST") return await handleJsonAction(req, res, "rename");
    await serveStatic(req, res, url);
  }catch(err){
    sendJson(res, 500, { ok: false, message: err?.message || String(err) });
  }
});

server.listen(port, () => {
  console.log(`Quiz admin server: http://localhost:${port}/admin.html`);
});
/* SOFTM-ADMIN 끝 */
