#!/usr/bin/env node
/* SOFTM-위치맵 시작: 렌더된 PDF 이미지에서 문제·문항 위치맵 JSON 생성 - 2026-05-30 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

function arg(name, fallback = ""){
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function run(command, args, options = {}){
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || process.cwd(),
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

function parsePdfPages(text){
  const match = String(text || "").match(/^Pages:\s*(\d+)/mi);
  return match ? Number(match[1]) : 0;
}

function parseTsv(text){
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((key, idx) => { row[key] = cells[idx] ?? ""; });
    return row;
  });
}

function groupTsvLines(rows){
  const grouped = new Map();
  for (const row of rows){
    if (String(row.level) !== "5") continue;
    const text = String(row.text || "").trim();
    if (!text) continue;
    const key = [row.page_num, row.block_num, row.par_num, row.line_num].join(":");
    const item = grouped.get(key) || { words: [], left: Infinity, top: Infinity, right: 0, bottom: 0, text: "" };
    const left = Number(row.left || 0);
    const top = Number(row.top || 0);
    const width = Number(row.width || 0);
    const height = Number(row.height || 0);
    item.words.push({ text, left, top, width, height, conf: Number(row.conf || 0) });
    item.left = Math.min(item.left, left);
    item.top = Math.min(item.top, top);
    item.right = Math.max(item.right, left + width);
    item.bottom = Math.max(item.bottom, top + height);
    grouped.set(key, item);
  }
  return [...grouped.values()].map((line) => ({
    ...line,
    text: line.words.map((word) => word.text).join(" "),
  })).sort((a, b) => a.top - b.top || a.left - b.left);
}

function detectQuestionLabel(line, cropWidth){
  const text = String(line.text || "").replace(/\s+/g, "");
  const first = String(line.words?.[0]?.text || "").replace(/\s+/g, "");
  const compact = first || text;
  const leftRatio = Number.isFinite(line.left) && cropWidth ? line.left / cropWidth : 1;
  const inLeftQuestionColumn = leftRatio <= 0.36;
  const inRightQuestionColumn = leftRatio >= 0.46 && leftRatio <= 0.66;
  if (!inLeftQuestionColumn && !inRightQuestionColumn) return null;
  let match = compact.match(/^(\d{1,3})[.)]/);
  if (!match) match = text.match(/^(\d{1,3})[.)]/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1 || value > 999) return null;
  if (value <= 5 && /^[1-5][.)]$/.test(compact) && leftRatio > 0.105 && leftRatio < 0.36) return null;
  const rest = text.slice(match[0].length);
  if (value < 10 && /^[1-5][.)]?[ㄱ-ㅎ가-힣A-Za-z]/.test(rest)) return null;
  if (value < 10 && /^[1-5][.)]\(/.test(rest)) return null;
  if (value < 10 && /^\d{2,}[)]?/.test(rest)) return null;
  return value;
}

function normalizeNumberSignText(text){
  return String(text || "")
    .normalize("NFKC")
    .replace(/[①❶➀]/g, "1")
    .replace(/[②❷➁]/g, "2")
    .replace(/[③❸➂]/g, "3")
    .replace(/[④❹➃]/g, "4")
    .replace(/[⑤❺➄]/g, "5")
    .replace(/\s+/g, "");
}

function parseQuestionNumberMarker(text, { allowBare = false } = {}){
  const compact = normalizeNumberSignText(text);
  let match = compact.match(/^(\d{1,3})[.)]/);
  if (!match && allowBare) match = compact.match(/^(\d{1,3})(?=$|[^\d])/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 && value <= 999 ? value : null;
}

function buildSyntheticNumberLine(line, word, text){
  const left = Number(word?.left ?? line.left ?? 0);
  const top = Number(word?.top ?? line.top ?? 0);
  const width = Math.max(1, Number(word?.width ?? 0));
  const height = Math.max(1, Number(word?.height ?? 0));
  return {
    ...line,
    left,
    top,
    right: left + width,
    bottom: top + height,
    text,
    words: [{ ...word, text }],
    sourceLineText: line.text,
  };
}

function detectQuestionLabelCandidates(line, meta){
  const out = [];
  const cropWidth = Number(meta?.cropWidth || 1);
  const addCandidate = (label, candidateLine, source, scoreAdjust = 0) => {
    if (!label) return;
    const leftRatio = Number.isFinite(candidateLine.left) && cropWidth ? candidateLine.left / cropWidth : 1;
    const inLeftQuestionColumn = leftRatio <= 0.36;
    const inRightQuestionColumn = leftRatio >= 0.46 && leftRatio <= 0.68;
    if (!inLeftQuestionColumn && !inRightQuestionColumn) return;
    const compact = normalizeNumberSignText(candidateLine.text);
    if (label <= 5 && /^[1-5][.)]?$/.test(compact) && leftRatio > 0.105 && leftRatio < 0.36) return;
    const anchorScore = Math.max(0.22, Math.min(1.30, questionAnchorCandidateScore(candidateLine, meta, label) + scoreAdjust));
    out.push({ label, line: candidateLine, source, anchorScore });
  };

  const lineLabel = detectQuestionLabel(line, cropWidth);
  if (lineLabel) addCandidate(lineLabel, line, "ocr-line-prefix", 0);

  const words = Array.isArray(line.words) ? line.words : [];
  for (let idx = 0; idx < Math.min(words.length, 4); idx += 1){
    const word = words[idx];
    const text = normalizeNumberSignText(word?.text);
    if (!text) continue;
    const wordLeft = Number(word.left || 0);
    const lineLeft = Number(line.left || 0);
    const startsLine = idx === 0 || Math.abs(wordLeft - lineLeft) <= Math.max(8, cropWidth * 0.012);
    if (!startsLine) continue;
    const next = normalizeNumberSignText(words[idx + 1]?.text);
    const next2 = normalizeNumberSignText(words[idx + 2]?.text);
    const forms = [
      { text, adjust: text.match(/^\d{1,3}[.)]/) ? 0.08 : -0.05 },
      { text: `${text}${next}`, adjust: 0.04 },
      { text: `${text}${next}${next2}`, adjust: 0.00 },
    ];
    for (const form of forms){
      const label = parseQuestionNumberMarker(form.text, { allowBare: true });
      if (!label) continue;
      const bare = !/^\d{1,3}[.)]/.test(form.text);
      if (bare && label < 10) continue;
      const synthetic = buildSyntheticNumberLine(line, word, form.text);
      addCandidate(label, synthetic, bare ? "ocr-number-layer-bare" : "ocr-number-layer", form.adjust + (bare ? -0.10 : 0.02));
    }
  }

  const seen = new Set();
  return out.filter((item) => {
    const key = [
      item.label,
      Math.round(Number(item.line.left || 0) / 3),
      Math.round(Number(item.line.top || 0) / 3),
      item.source,
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
// SOFTM-위치맵: OCR에서 숫자/문항 부호만 뽑은 전용 후보 레이어를 만들어 문제번호 후보를 보강 - 2026-06-01

function detectChoiceToken(text){
  const compact = normalizeNumberSignText(text);
  let match = compact.match(/^\(?([1-5])\)?$/);
  if (match) return Number(match[1]);
  match = compact.match(/^([1-5])[.)]$/);
  if (match) return Number(match[1]);
  match = compact.match(/^\(([1-5])\)$/);
  if (match) return Number(match[1]);
  const markerOnly = compact.replace(/[^0-9().]/g, "");
  match = markerOnly.match(/^\(?([1-5])\)?[.)]?$/);
  if (match) return Number(match[1]);
  return null;
}
// SOFTM-위치맵: 이미지 원형 검출이 약한 PDF는 OCR 숫자/문항 부호 토큰도 선택지 후보로 사용 - 2026-06-01

function questionAnchorCandidateScore(line, meta, label){
  const text = String(line.text || "").replace(/\s+/g, "");
  const first = String(line.words?.[0]?.text || "").replace(/\s+/g, "");
  const compact = first || text;
  const width = Math.max(1, Number(meta.width || 1));
  const height = Math.max(1, Number(meta.height || 1));
  const xRatio = (Number(meta.cropX || 0) + Number(line.left || 0)) / width;
  const lineHeightRatio = Math.max(0, (Number(line.bottom || 0) - Number(line.top || 0)) / height);
  let score = 0.72;
  if (xRatio <= 0.14 || (xRatio >= 0.46 && xRatio <= 0.62)) score += 0.18;
  if (lineHeightRatio >= 0.010) score += 0.08;
  if (Number(label) >= 10) score += 0.06;
  if (compact.length > String(label).length + 1) score += 0.04;
  if (Number(label) <= 5 && xRatio > 0.07 && xRatio < 0.20) score -= 0.14;
  if (Number(label) < 10 && /^\d[.)][1-5][.)]?[ㄱ-ㅎ가-힣A-Za-z]/.test(text)) score -= 0.52;
  if (Number(label) < 10 && /^\d[.)][1-5][.)]\(/.test(text)) score -= 0.60;
  if (/^[1-5][.)]?\)?$/.test(compact)) score -= 0.34;
  if (Number(label) <= 5 && compact.includes(")") && !compact.includes(".")) score -= 0.10;
  return Math.max(0.28, Math.min(1.22, score));
}
// SOFTM-위치맵: 문제번호 후보를 위치/크기/순서 친화도로 점수화해 보기 숫자와 문제번호를 분리 - 2026-06-01

function sortedAnchorCandidates(rawAnchors){
  const pageColumnMode = new Map();
  const byPage = new Map();
  for (const item of rawAnchors){
    const page = Number(item.page) || 1;
    const list = byPage.get(page) || [];
    list.push(Number(item.xRatio));
    byPage.set(page, list);
  }
  for (const [page, xs] of byPage.entries()){
    const left = xs.filter((x) => Number.isFinite(x) && x < 0.36).length;
    const right = xs.filter((x) => Number.isFinite(x) && x > 0.42 && x < 0.86).length;
    pageColumnMode.set(page, left >= 2 && right >= 2);
  }
  const columnFor = (item) => pageColumnMode.get(Number(item.page) || 1) && Number(item.xRatio) >= 0.42 ? 1 : 0;
  return rawAnchors.slice().map((item) => ({
    ...item,
    anchorColumn: columnFor(item),
  })).sort((a, b) => (
    a.page - b.page
    || Number(a.anchorColumn || 0) - Number(b.anchorColumn || 0)
    || a.yRatio - b.yRatio
    || a.xRatio - b.xRatio
    || a.label - b.label
  ));
}
// SOFTM-위치맵: 2단 문서는 페이지 안에서 왼쪽 컬럼을 모두 읽은 뒤 오른쪽 컬럼을 읽도록 정렬 - 2026-05-31

function expandRepairLabelCandidates(rawAnchors, startNo, endNo){
  const out = [];
  let repairId = 0;
    for (const item of rawAnchors){
    out.push({ ...item, labelWeight: 1, repairedLabel: false, repairId: repairId += 1 });
    const label = Number(item.label);
    if (!Number.isInteger(label) || label < 1 || label > 99) continue;
    const compactText = String(item.text || "").replace(/\s+/g, "");
    if (label < 10 && new RegExp(`^${label}[.)]`).test(compactText)) continue;
    const suffixBase = label < 10 ? 10 : 100;
    const suffix = label % suffixBase;
    if (!suffix) continue;
    for (let candidate = startNo; candidate <= endNo; candidate += 1){
      if (candidate === label) continue;
      if (candidate % suffixBase !== suffix) continue;
      out.push({
        ...item,
        label: candidate,
        originalLabel: label,
        labelWeight: label < 10 ? 0.74 : 0.82,
        repairedLabel: true,
        repairId: repairId += 1,
      });
    }
    const cleanSingleLabel = label < 10 && new RegExp(`^${label}[.)]$`).test(compactText);
    if (label < 10 && !cleanSingleLabel) {
      for (const candidate of [label - 1, label + 1]){
        if (candidate < startNo || candidate > endNo || candidate === label) continue;
        out.push({
          ...item,
          label: candidate,
          originalLabel: label,
          labelWeight: 0.58,
          repairedLabel: true,
          adjacentRepair: true,
          repairId: repairId += 1,
        });
      }
    }
  }
  return out;
}
// SOFTM-위치맵: OCR이 63을 03/3처럼 앞자리 없이 읽어도 문항 범위와 순서로 복구 후보를 생성 - 2026-05-31
// SOFTM-위치맵: 2024처럼 한 자리 문제번호가 1/2/3 등으로 인접 오인식되는 경우도 순서 기반 복구 후보로 유지하되, 깨끗한 단독 문제번호는 인접 번호로 바꾸지 않음 - 2026-06-01

function selectMonotonicAnchors(rawAnchors, startNo, questionCount){
  const endNo = startNo + questionCount - 1;
  const candidates = sortedAnchorCandidates(expandRepairLabelCandidates(rawAnchors, startNo, endNo))
    .filter((item) => item.label >= startNo && item.label <= endNo);
  const n = candidates.length;
  if (!n) return { anchors: [], score: 0 };
  const weightFor = (item) => Number(item.labelWeight || 1) * Number(item.anchorScore || 1);
  const dp = Array(n).fill(0).map((_v, i) => (
    weightFor(candidates[i])
    + (candidates[i].label === startNo ? 0.55 : 0)
  ));
  const prev = Array(n).fill(-1);
  for (let i = 0; i < n; i += 1){
    for (let j = 0; j < i; j += 1){
      if (candidates[j].label >= candidates[i].label) continue;
      const samePage = candidates[j].page === candidates[i].page;
      const prevColumn = Number(candidates[j].anchorColumn || 0);
      const currentColumn = Number(candidates[i].anchorColumn || 0);
      const pageOrderOk = candidates[j].page < candidates[i].page
        || (
          samePage
          && (
            prevColumn < currentColumn
            || (prevColumn === currentColumn && candidates[j].yRatio + 0.006 < candidates[i].yRatio)
          )
        );
      if (!pageOrderOk) continue;
      if (
        samePage
        && prevColumn === currentColumn
        && candidates[i].label === candidates[j].label + 1
        && candidates[i].yRatio - candidates[j].yRatio < 0.075 // SOFTM-위치맵: 페이지 상단 보기 원형이 다음 문제번호로 승격되는 OCR 오검출을 더 강하게 차단 - 2026-06-17
      ) {
        continue;
      }
      // SOFTM-위치맵: 같은 페이지에서 연속 문제번호가 너무 가까우면 보기/본문 숫자 OCR 오인식으로 보고 문제 시작 앵커에서 제외 - 2026-05-31
      const gapPenalty = Math.min(0.25, Math.max(0, candidates[i].label - candidates[j].label - 1) * 0.01);
      const consecutiveBonus = candidates[i].label === candidates[j].label + 1 ? 0.025 : 0;
      const nextScore = dp[j] + weightFor(candidates[i]) + consecutiveBonus - gapPenalty;
      if (nextScore > dp[i]) {
        dp[i] = nextScore;
        prev[i] = j;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i += 1){
    if (dp[i] > dp[best]) best = i;
  }
  const selected = [];
  for (let idx = best; idx >= 0; idx = prev[idx]){
    selected.push(candidates[idx]);
    if (prev[idx] < 0) break;
  }
  selected.reverse();
  return { anchors: selected, score: dp[best] };
}

function inferStartAndSelectAnchors(rawAnchors, configuredStart, questionCount){
  const labels = [...new Set(rawAnchors.map((item) => item.label))]
    .filter((value) => value >= 1 && value <= 999)
    .sort((a, b) => a - b);
  const starts = [...new Set([configuredStart, 1, ...labels])]
    .filter((value) => Number.isInteger(value) && value >= 1);
  const startPrior = (start) => {
    if (configuredStart && start === configuredStart) return 0.84;
    if (start === 1) return questionCount >= 80 ? 0.80 : 0.08;
    return 0;
  };
  let best = { questionStartNo: 1, selected: selectMonotonicAnchors(rawAnchors, 1, questionCount) };
  for (const start of starts){
    const selected = selectMonotonicAnchors(rawAnchors, start, questionCount);
    const currentScore = selected.score + startPrior(start);
    const bestScore = best.selected.score + startPrior(best.questionStartNo);
    if (currentScore > bestScore) best = { questionStartNo: start, selected };
  }
  return best;
}
// SOFTM-위치맵: PDF 문제번호가 1이 아닌 시작번호여도 자동 추론하고, 기존 시작번호는 낮은 가중치 힌트로만 사용 - 2026-05-30

function repairColumnTransitionLabelDrift(anchors, questionStartNo, questionCount){
  const endNo = questionStartNo + questionCount - 1;
  const ordered = sortedAnchorCandidates(Array.isArray(anchors) ? anchors : []);
  const byPage = new Map();
  for (const anchor of ordered){
    const page = Number(anchor.page) || 1;
    const list = byPage.get(page) || [];
    list.push(anchor);
    byPage.set(page, list);
  }
  for (const list of byPage.values()){
    const right = list.filter((item) => Number(item.anchorColumn || 0) === 1);
    const left = list.filter((item) => Number(item.anchorColumn || 0) === 0);
    if (right.length < 2 || !left.length) continue;
    const firstRight = right[0];
    const previousLeft = left.filter((item) => Number(item.yRatio) < 0.93).at(-1);
    if (!previousLeft) continue;
    if (Number(previousLeft.yRatio) < 0.78) continue;
    const gap = Number(firstRight.label) - Number(previousLeft.label) - 1;
    if (!Number.isInteger(gap) || gap < 1 || gap > 2) continue;
    if (Number(firstRight.yRatio) > 0.34) continue;
    const shiftedLabels = new Set();
    let ok = true;
    for (const item of right){
      const nextLabel = Number(item.label) - gap;
      if (nextLabel <= Number(previousLeft.label) || nextLabel < questionStartNo || nextLabel > endNo || shiftedLabels.has(nextLabel)) {
        ok = false;
        break;
      }
      shiftedLabels.add(nextLabel);
    }
    if (!ok) continue;
    for (const item of right){
      if (item.columnDriftRepair) continue;
      item.originalLabel = item.originalLabel ?? item.label;
      item.label = Number(item.label) - gap;
      item.repairedLabel = true;
      item.columnDriftRepair = true;
      item.labelWeight = Math.max(Number(item.labelWeight || 1), 0.96);
    }
  }
  return sortedAnchorCandidates(ordered);
}
// SOFTM-위치맵: 2단 페이지 컬럼 전환부에서 OCR이 오른쪽 컬럼 문제번호를 한 칸 크게 읽으면 지면 읽기 순서로 보정 - 2026-06-01

function fillMissingAnchors(anchorByLocal, pageCount, questionCount){
  const pageMap = Array(questionCount + 1).fill(null);
  const topMap = Array(questionCount + 1).fill(null);
  const known = [...anchorByLocal.values()].sort((a, b) => a.q - b.q);
  for (const item of known){
    pageMap[item.q] = item.page;
    topMap[item.q] = item.yRatio;
  }
  if (!known.length) {
    const perPage = Math.max(1, Math.ceil(questionCount / Math.max(1, pageCount)));
    for (let q = 1; q <= questionCount; q++){
      pageMap[q] = Math.min(pageCount || 1, Math.ceil(q / perPage));
      topMap[q] = 0.12 + (((q - 1) % perPage) * 0.72 / perPage);
    }
    return { pageMap, topMap };
  }
  for (let q = 1; q <= questionCount; q++){
    if (pageMap[q] != null && topMap[q] != null) continue;
    const prev = known.filter((item) => item.q < q).at(-1) || null;
    const next = known.find((item) => item.q > q) || null;
    if (prev && next) {
      const span = Math.max(1, next.q - prev.q);
      const ratio = (q - prev.q) / span;
      const interpolatedPage = Math.round(prev.page + ((next.page - prev.page) * ratio));
      pageMap[q] = Math.max(1, Math.min(pageCount || next.page || prev.page || 1, interpolatedPage));
      if (
        prev.page === next.page
        && Number.isFinite(Number(prev.anchorColumn))
        && Number.isFinite(Number(next.anchorColumn))
        && Number(prev.anchorColumn) !== Number(next.anchorColumn)
      ) {
        pageMap[q] = prev.page;
        const missingCount = Math.max(1, next.q - prev.q - 1);
        const missingIndex = Math.max(1, q - prev.q);
        const pageTail = Number(prev.anchorColumn) < Number(next.anchorColumn) ? 0.91 : 0.86;
        const laneProgress = Math.min(1, missingIndex / missingCount);
        topMap[q] = Number(prev.yRatio) + ((pageTail - Number(prev.yRatio)) * laneProgress);
        // SOFTM-위치맵: 2단 같은 페이지에서 왼쪽 컬럼 끝 문제번호가 빠진 경우 오른쪽 컬럼 첫 문제와 세로 보간하지 않고 현재 컬럼 하단으로 배치 - 2026-06-03
      } else if (prev.page === next.page) {
        topMap[q] = prev.yRatio + ((next.yRatio - prev.yRatio) * ratio);
      } else if (Number(prev.anchorColumn || 0) === 1) {
        const projected = Number(prev.yRatio) + (0.125 * (q - prev.q));
        if (projected <= 0.92) {
          pageMap[q] = prev.page;
          topMap[q] = projected;
        } else {
          pageMap[q] = next.page;
          topMap[q] = Math.max(0.08, next.yRatio - (0.07 * (next.q - q)));
        }
        // SOFTM-위치맵: 2단 문서 오른쪽 컬럼에서 일부 문제번호 OCR이 빠져도 다음 페이지로 넘기지 않고 현재 컬럼 하단으로 보간 - 2026-06-01
      } else if (pageMap[q] === prev.page) {
        topMap[q] = Math.min(0.86, prev.yRatio + (0.07 * (q - prev.q)));
      } else if (pageMap[q] === next.page) {
        topMap[q] = Math.max(0.08, next.yRatio - (0.07 * (next.q - q)));
      } else {
        topMap[q] = 0.12;
      }
    } else if (prev) {
      const offset = q - prev.q;
      pageMap[q] = Math.min(pageCount || prev.page || 1, prev.page + Math.floor((prev.yRatio + 0.07 * offset) / 0.86));
      topMap[q] = Math.min(0.86, Math.max(0.08, prev.yRatio + (0.07 * offset)));
    } else if (next) {
      const offset = next.q - q;
      pageMap[q] = Math.max(1, next.page - Math.floor((0.07 * offset) / 0.76));
      topMap[q] = Math.max(0.08, next.yRatio - (0.07 * offset));
    }
  }
  const knownQs = new Set(known.map((item) => item.q));
  for (let page = 1; page <= (pageCount || 1); page += 1){
    const firstKnown = known.find((item) => Number(item.page) === page);
    if (!firstKnown) continue;
    const missingBeforeFirst = [];
    const prevKnown = known.filter((item) => item.q < firstKnown.q).at(-1) || null;
    const firstRoom = Math.max(1, Math.floor((Number(firstKnown.yRatio) - (page === 1 ? 0.12 : 0.064)) / 0.082));
    const forcedTopQs = [];
    if (prevKnown && Number(prevKnown.page) < page && Number(prevKnown.anchorColumn || 0) !== 1) {
      for (let q = prevKnown.q + 1; q < firstKnown.q; q += 1){
        if (!knownQs.has(q)) forcedTopQs.push(q);
      }
    }
    const forcedTopSet = new Set(forcedTopQs.slice(Math.max(0, forcedTopQs.length - firstRoom)));
    for (let q = 1; q < firstKnown.q; q += 1){
      if (knownQs.has(q)) continue;
      if (Number(pageMap[q]) === page || forcedTopSet.has(q)) missingBeforeFirst.push(q);
    }
    if (!missingBeforeFirst.length) continue;
    const pageTop = page === 1 ? 0.12 : 0.064;
    const firstGap = Math.max(0, Number(firstKnown.yRatio) - pageTop);
    missingBeforeFirst.forEach((q, idx) => {
      pageMap[q] = page;
      const projected = firstGap > 0.12
        ? pageTop + (firstGap * (idx + 1) / (missingBeforeFirst.length + 1))
        : pageTop + (idx * 0.072);
      const limit = Math.max(0.045, Number(firstKnown.yRatio) - (0.05 * (missingBeforeFirst.length - idx)));
      topMap[q] = Math.max(0.045, Math.min(limit, projected));
    });
  }
  // SOFTM-위치맵: 새 PDF 페이지의 첫 문제번호 OCR이 누락되면 실제 상단 여백 폭에 맞춰 누락 문제 시작선을 분배 - 2026-05-30
  for (let q = 1; q <= questionCount; q++){
    pageMap[q] = Math.max(1, Math.min(pageCount || 1, Number(pageMap[q]) || 1));
    topMap[q] = Math.max(0.035, Math.min(0.92, (Number(topMap[q]) || 0.12) - 0.055));
  }
  // SOFTM-위치맵: 문제 시작선이 큰 제목 글자/여러 줄 지문을 가로지르지 않도록 컷 시작 위치를 충분히 위로 보정 - 2026-06-01
  return { pageMap, topMap };
}

function buildQuestionColumnLayoutMap(cropMeta){
  const out = {};
  for (const item of Array.isArray(cropMeta) ? cropMeta : []){
    const page = Number(item.pageNo || item.page || item.originalPage || item.sourcePage || 0);
    const width = Math.max(1, Number(item.width || item.pageWidth || 1));
    const cropX = Number(item.cropX ?? item.x ?? 0);
    const cropWidth = Number(item.cropWidth ?? item.widthPx ?? item.w ?? 0);
    const kind = String(item.cropKind || item.kind || item.columnKind || "").toLowerCase();
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(cropX) || !Number.isFinite(cropWidth) || cropWidth <= 0) continue;
    const leftRatio = Math.max(0, Math.min(1, cropX / width));
    const rightRatio = Math.max(0, Math.min(1, (cropX + cropWidth) / width));
    if (rightRatio - leftRatio > 0.72) continue;
    const entry = out[String(page)] || { page, left: null, right: null };
    const mid = (leftRatio + rightRatio) * 0.5;
    if (kind.includes("col0") || kind.includes("left") || mid < 0.5) entry.left = { left: leftRatio, right: rightRatio };
    if (kind.includes("col1") || kind.includes("right") || mid >= 0.5) entry.right = { left: leftRatio, right: rightRatio };
    out[String(page)] = entry;
  }
  for (const [page, entry] of Object.entries(out)){
    if (!entry.left || !entry.right) {
      delete out[page];
      continue;
    }
    const split = Math.max(0.34, Math.min(0.66, (Number(entry.left.right) + Number(entry.right.left)) * 0.5));
    out[page] = {
      split,
      left: { left: Math.max(0, Number(entry.left.left) || 0), right: Math.min(1, Math.max(split, Number(entry.left.right) || split)), column: 0 },
      right: { left: Math.max(0, Math.min(split, Number(entry.right.left) || split)), right: Math.min(1, Number(entry.right.right) || 1), column: 1 },
    };
  }
  return out;
}

function buildQuestionColumnBoundsMap(anchorByLocal, pageMap, questionCount, pageColumnLayoutMap = {}){
  const byPage = new Map();
  for (const anchor of anchorByLocal.values()){
    const page = Number(anchor.page);
    const x = Number(anchor.xRatio);
    if (!Number.isFinite(page) || !Number.isFinite(x)) continue;
    const list = byPage.get(page) || [];
    list.push({ q: Number(anchor.q), x });
    byPage.set(page, list);
  }
  const pageMeta = new Map();
  for (const [page, items] of byPage.entries()){
    const xs = items.map((item) => item.x).filter((x) => Number.isFinite(x) && x >= 0.025 && x <= 0.90);
    const left = xs.filter((x) => x < 0.36);
    const right = xs.filter((x) => x > 0.42);
    if (left.length < 2 || right.length < 2) continue;
    const leftMax = Math.max(...left);
    const rightMin = Math.min(...right);
    if (!Number.isFinite(leftMax) || !Number.isFinite(rightMin) || rightMin - leftMax < 0.12) continue;
    const split = Math.max(0.36, Math.min(0.64, (leftMax + rightMin) * 0.5));
    pageMeta.set(page, {
      split,
      left: { left: 0, right: Math.min(1, split + 0.055), column: 0 },
      right: { left: Math.max(0, split - 0.055), right: 1, column: 1 },
    });
  }
  const normalizeColumnMeta = (layout) => {
    if (!layout || !layout.left || !layout.right) return null;
    const split = Math.max(0.34, Math.min(0.66, Number(layout.split) || 0.5));
    return {
      split,
      left: { left: Math.max(0, Math.min(1, Number(layout.left.left) || 0)), right: Math.max(0, Math.min(1, Number(layout.left.right) || split)), column: 0 },
      right: { left: Math.max(0, Math.min(1, Number(layout.right.left) || split)), right: Math.max(0, Math.min(1, Number(layout.right.right) || 1)), column: 1 },
    };
  };
  for (const [pageKey, layout] of Object.entries(pageColumnLayoutMap || {})){
    const page = Number(pageKey);
    if (!Number.isFinite(page)) continue;
    const normalized = normalizeColumnMeta(layout);
    if (normalized) pageMeta.set(page, normalized);
  }
  const pageQs = new Map();
  for (let q = 1; q <= questionCount; q += 1){
    const page = Number(pageMap[q]);
    if (!Number.isFinite(page)) continue;
    const list = pageQs.get(page) || [];
    list.push(q);
    pageQs.set(page, list);
  }
  const fallbackMeta = [...pageMeta.values()][0] || null;
  if (fallbackMeta && questionCount <= 60) {
    for (const [page, qs] of pageQs.entries()){
      if (!pageMeta.has(page) && qs.length >= 4) {
        pageMeta.set(page, {
          split: fallbackMeta.split,
          left: { ...fallbackMeta.left },
          right: { ...fallbackMeta.right },
        });
      }
    }
  }
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const page = Number(pageMap[q]);
    const meta = pageMeta.get(page);
    if (!meta) continue;
    const anchor = anchorByLocal.get(q) || null;
    const x = Number(anchor?.xRatio);
    const anchorColumn = Number(anchor?.anchorColumn);
    let side = anchorColumn === 1
      ? "right"
      : (anchorColumn === 0
        ? "left"
        : (Number.isFinite(x) ? (x >= meta.split ? "right" : "left") : ""));
    if (!side) {
      const qs = pageQs.get(page) || [];
      const idx = qs.indexOf(q);
      side = idx >= Math.ceil(qs.length / 2) ? "right" : "left";
    }
    const bounds = side === "right" ? meta.right : meta.left;
    out[String(q)] = {
      page,
      left: bounds.left,
      right: bounds.right,
      split: meta.split,
      column: bounds.column,
      source: anchor ? "anchor-column" : "inferred-column",
    };
  }
  return out;
}
// SOFTM-위치맵: 2단 PDF의 선택지 탐색과 풀이 화면 크롭을 현재 문항 컬럼으로 제한하기 위한 컬럼 경계 저장 - 2026-06-01

function completeQuestionLabelMap(anchorByLocal, pageMap, topMap, questionColumnBoundsMap, questionCount){
  const out = {};
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const sameLane = (a, b) => {
    if (!a || !b) return true;
    const ac = Number(a.column);
    const bc = Number(b.column);
    if (Number.isFinite(ac) && Number.isFinite(bc)) return ac === bc;
    const al = Number(a.left);
    const ar = Number(a.right);
    const bl = Number(b.left);
    const br = Number(b.right);
    if (![al, ar, bl, br].every(Number.isFinite)) return true;
    return Math.max(al, bl) < Math.min(ar, br) - 0.08;
  };
  const boundsFor = (q) => {
    const bounds = questionColumnBoundsMap[String(q)] || {};
    return {
      page: Number(pageMap[q]),
      left: Number.isFinite(Number(bounds.left)) ? Number(bounds.left) : 0,
      right: Number.isFinite(Number(bounds.right)) ? Number(bounds.right) : 1,
      column: Number.isFinite(Number(bounds.column)) ? Number(bounds.column) : null,
    };
  };
  for (const [q, anchor] of anchorByLocal.entries()){
    out[String(q)] = {
      page: anchor.page,
      xRatio: anchor.xRatio,
      yRatio: anchor.yRatio,
      anchorColumn: Number(anchor.anchorColumn || 0),
      text: anchor.text,
      markerText: anchor.markerText,
      source: anchor.source,
    };
  }
  const knownXForLane = (q) => {
    const page = Number(pageMap[q]);
    const lane = boundsFor(q);
    const xs = [];
    for (let other = 1; other <= questionCount; other += 1){
      const label = out[String(other)];
      if (!label || Number(label.page) !== page) continue;
      if (!sameLane(lane, boundsFor(other))) continue;
      const x = Number(label.xRatio);
      if (Number.isFinite(x)) xs.push(x);
    }
    xs.sort((a, b) => a - b);
    if (xs.length) return xs[Math.floor(xs.length / 2)];
    const left = Number.isFinite(lane.left) ? lane.left : 0;
    const right = Number.isFinite(lane.right) ? lane.right : 1;
    const width = Math.max(0.10, right - left);
    return clamp(left + Math.min(0.050, width * 0.095), 0.025, 0.92);
  };
  for (let q = 1; q <= questionCount; q += 1){
    if (out[String(q)]) continue;
    const page = Number(pageMap[q]);
    const top = Number(topMap[q]);
    if (!Number.isFinite(page) || !Number.isFinite(top)) continue;
    const lane = boundsFor(q);
    let prev = null;
    let next = null;
    for (let other = q - 1; other >= 1; other -= 1){
      const label = out[String(other)];
      if (!label || Number(label.page) !== page) continue;
      if (!sameLane(lane, boundsFor(other))) continue;
      prev = { q: other, label };
      break;
    }
    for (let other = q + 1; other <= questionCount; other += 1){
      const label = out[String(other)];
      if (!label || Number(label.page) !== page) continue;
      if (!sameLane(lane, boundsFor(other))) continue;
      next = { q: other, label };
      break;
    }
    let yRatio = null;
    if (prev && next && next.q > prev.q) {
      const prevY = Number(prev.label.yRatio);
      const nextY = Number(next.label.yRatio);
      const t = (q - prev.q) / Math.max(1, next.q - prev.q);
      if (Number.isFinite(prevY) && Number.isFinite(nextY) && nextY > prevY + 0.030) {
        yRatio = prevY + ((nextY - prevY) * t);
      }
    }
    if (!Number.isFinite(yRatio)) {
      const hasNextSameLane = !!next;
      yRatio = hasNextSameLane ? top + 0.055 : top;
    }
    out[String(q)] = {
      page,
      xRatio: knownXForLane(q),
      yRatio: clamp(yRatio, 0.040, 0.965),
      anchorColumn: Number.isFinite(lane.column) ? lane.column : 0,
      inferred: true,
      source: "inferred-column-flow",
    };
  }
  return out;
}
// SOFTM-위치맵: 2단 OCR에서 빠진 문제번호 라벨을 같은 컬럼 흐름으로 보간해 저장 좌표와 선택지 탐색 경계를 안정화 - 2026-06-03

function sameSegmentLane(a, b){
  if (!a || !b) return true;
  const ac = Number(a.column);
  const bc = Number(b.column);
  if (Number.isFinite(ac) && Number.isFinite(bc)) return ac === bc;
  const al = Number(a.left);
  const ar = Number(a.right);
  const bl = Number(b.left);
  const br = Number(b.right);
  if (![al, ar, bl, br].every(Number.isFinite)) return true;
  return Math.max(al, bl) < Math.min(ar, br) - 0.08;
}

function buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, choiceAnchorMap = {}, questionLabelMap = {}, choiceCount = 0){
  const out = {};
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  /* SOFTM-연속문항 시작: 2단 문항이 다음 단/페이지로 이어지면 추가 segment를 저장해 스크롤·편집 hit 영역으로 사용 - 2026-06-16 */
  const minContinuationHeight = 0.060;
  const boundsFor = (q) => {
    const bounds = questionColumnBoundsMap[String(q)] || {};
    const left = Number.isFinite(Number(bounds.left)) ? clamp(Number(bounds.left), 0, 1) : 0;
    const right = Number.isFinite(Number(bounds.right)) ? clamp(Number(bounds.right), 0, 1) : 1;
    return {
      page: Number.isFinite(Number(bounds.page)) ? Number(bounds.page) : Number(pageMap[q]),
      left,
      right,
      column: Number.isFinite(Number(bounds.column)) ? Number(bounds.column) : null,
    };
  };
  const pageLanes = new Map();
  const addPageLane = (page, lane) => {
    const safePage = Number(page);
    const column = Number(lane?.column);
    const left = Number(lane?.left);
    const right = Number(lane?.right);
    if (!Number.isFinite(safePage) || !Number.isFinite(column) || !Number.isFinite(left) || !Number.isFinite(right)) return;
    if (right <= left + 0.08) return;
    const meta = pageLanes.get(safePage) || new Map();
    const list = meta.get(column) || [];
    list.push({ left: clamp(left, 0, 1), right: clamp(right, 0, 1), column });
    meta.set(column, list);
    pageLanes.set(safePage, meta);
  };
  for (let q = 1; q <= questionCount; q += 1){
    const lane = boundsFor(q);
    addPageLane(lane.page, lane);
  }
  const laneForPageColumn = (page, column) => {
    const meta = pageLanes.get(Number(page));
    const list = meta?.get(Number(column)) || [];
    if (!list.length) return null;
    const median = (values) => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
    };
    const left = median(list.map((item) => Number(item.left)));
    const right = median(list.map((item) => Number(item.right)));
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left + 0.08) return null;
    return { page: Number(page), left, right, column: Number(column) };
  };
  const hasTwoColumnPage = (page) => !!(laneForPageColumn(page, 0) && laneForPageColumn(page, 1));
  const isLastQuestionInLane = (q, page, lane) => {
    const currentTop = Number(topMap[q]);
    for (let other = q + 1; other <= questionCount; other += 1){
      if (Number(pageMap[other]) !== Number(page)) continue;
      if (!sameSegmentLane(lane, boundsFor(other))) continue;
      const otherTop = Number(topMap[other]);
      if (Number.isFinite(otherTop) && (!Number.isFinite(currentTop) || otherTop > currentTop + 0.018)) return false;
    }
    return true;
  };
  const questionBoundaryTop = (q) => {
    const labelTop = Number(questionLabelMap[String(q)]?.yRatio);
    const top = Number(topMap[q]);
    if (Number.isFinite(labelTop) && Number.isFinite(top)) return Math.min(labelTop, top);
    if (Number.isFinite(labelTop)) return labelTop;
    return Number.isFinite(top) ? top : NaN;
  };
  const questionLabelBoundaryTop = (q) => {
    const labelTop = Number(questionLabelMap[String(q)]?.yRatio);
    if (Number.isFinite(labelTop)) return labelTop;
    const top = Number(topMap[q]);
    return Number.isFinite(top) ? top : NaN;
  };
  const hasCompleteChoiceAnchorsInLane = (q, page, lane) => {
    const expected = Math.max(0, Math.trunc(Number(choiceCount) || 0));
    if (!expected) return false;
    const anchors = Array.isArray(choiceAnchorMap?.[String(q)]) ? choiceAnchorMap[String(q)] : [];
    const choices = new Set();
    for (const anchor of anchors){
      if (Number(anchor?.page) !== Number(page)) continue;
      const x = Number(anchor?.xRatio);
      const choice = Number(anchor?.choice);
      if (!Number.isFinite(x) || !Number.isInteger(choice) || choice < 1 || choice > expected) continue;
      if (x < Number(lane.left) - 0.030 || x > Number(lane.right) + 0.030) continue;
      choices.add(choice);
    }
    return choices.size >= expected;
  };
  const buildContinuationSegment = (q, currentLane) => {
    const page = Number(pageMap[q]);
    const nextQ = q + 1;
    const nextPage = Number(pageMap[nextQ]);
    if (!Number.isFinite(page) || !Number.isFinite(nextPage) || nextQ > questionCount) return null;
    if (!Number.isFinite(Number(currentLane?.column))) return null;
    if (!isLastQuestionInLane(q, page, currentLane)) return null;
    if (hasCompleteChoiceAnchorsInLane(q, page, currentLane)) return null; // SOFTM-연속문항: 현재 단에서 문항앵커가 완결된 문제는 반대 단 continuation을 붙이지 않음 - 2026-06-17
    let targetPage = 0;
    let targetColumn = null;
    let source = "";
    if (Number(currentLane.column) === 0 && nextPage === page && hasTwoColumnPage(page)) {
      const nextLane = boundsFor(nextQ);
      if (Number(nextLane.column) !== 1) return null;
      targetPage = page;
      targetColumn = 1;
      source = "column-continuation";
    } else if (Number(currentLane.column) === 1 && nextPage > page && hasTwoColumnPage(nextPage)) {
      const nextLane = boundsFor(nextQ);
      if (Number(nextLane.column) !== 0) return null;
      targetPage = nextPage;
      targetColumn = 0;
      source = "page-continuation";
    } else {
      return null;
    }
    const targetLane = laneForPageColumn(targetPage, targetColumn);
    if (!targetLane) return null;
    const targetTop = 0.035;
    const nextBoundary = questionBoundaryTop(nextQ); // SOFTM-연속문항: continuation도 다음 문제 top/label 중 이른 hard boundary를 넘지 않게 제한 - 2026-06-18
    if (!Number.isFinite(nextBoundary) || nextBoundary <= targetTop + minContinuationHeight) return null;
    const bottom = clamp(nextBoundary - 0.006, targetTop, 0.970); // SOFTM-연속문항: continuation은 다음 문제번호 직전까지 허용해 하단 이미지 선택지가 잘리지 않게 함 - 2026-06-17
    if (bottom <= targetTop + minContinuationHeight) return null;
    return {
      page: targetPage,
      top: targetTop,
      bottom,
      left: targetLane.left,
      right: targetLane.right,
      column: targetLane.column,
      continuation: true,
      fromColumn: Number(currentLane.column),
      toColumn: targetLane.column,
      source,
    };
  };
  /* SOFTM-연속문항 끝 */
  for (let q = 1; q <= questionCount; q += 1){
    const page = Number(pageMap[q]);
    let start = Number(topMap[q]);
    if (!Number.isFinite(page) || !Number.isFinite(start)) continue;
    const currentLane = boundsFor(q);
    const currentLabelTop = Number(questionLabelMap[String(q)]?.yRatio);
    if (Number.isFinite(currentLabelTop)) {
      let hasPrevSameLane = false;
      for (let prev = q - 1; prev >= 1; prev -= 1){
        if (Number(pageMap[prev]) !== page) continue;
        if (sameSegmentLane(currentLane, boundsFor(prev))) {
          hasPrevSameLane = true;
          break;
        }
      }
      if (hasPrevSameLane) {
        start = Math.max(start, clamp(currentLabelTop - 0.006, 0.02, 0.97)); // SOFTM-위치맵: 다음 문제와 겹치지 않도록 문제 label 위 segment 여백을 줄임 - 2026-06-17
      }
    }
    let end = 0.95;
    let hardEnd = null;
    let hardBoundary = null;
    for (let next = q + 1; next <= questionCount; next += 1){
      if (Number(pageMap[next]) !== page) continue;
      const nextLane = boundsFor(next);
      if (!sameSegmentLane(currentLane, nextLane)) continue;
      const nextTop = Number(topMap[next]);
      const nextLabelTop = Number(questionLabelMap[String(next)]?.yRatio);
      const hasNextLabel = Number.isFinite(nextLabelTop) && nextLabelTop > start + 0.018;
      const nextBoundary = hasNextLabel ? nextLabelTop : nextTop;
      if (!Number.isFinite(nextBoundary) || nextBoundary <= start + 0.018) continue;
      hardBoundary = nextBoundary;
      hardEnd = clamp(nextBoundary - 0.006, start + 0.05, 0.97); // SOFTM-위치맵: 이전 문제 bottom은 다음 문제 label 직전까지만 허용해 보기 영역 침범을 차단 - 2026-06-17
      end = hardEnd;
      break;
    }
    const choices = Array.isArray(choiceAnchorMap[String(q)]) ? choiceAnchorMap[String(q)] : [];
    let choiceBottom = 0;
    for (const choice of choices){
      if (Number(choice.page) !== page) continue;
      const x = Number(choice.xRatio);
      const y = Number(choice.yRatio);
      const h = Number(choice.hRatio || 0.02);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < currentLane.left - 0.025 || x > currentLane.right + 0.025) continue;
      choiceBottom = Math.max(choiceBottom, y + Math.max(0.018, h));
    }
    if (choiceBottom > start) {
      const extendedEnd = clamp(choiceBottom + 0.035, start + 0.05, 0.97);
      if (hardEnd == null) {
        end = Math.max(end, extendedEnd);
      } else {
        const choiceAwareEnd = choiceBottom <= hardEnd + 0.002
          ? Math.min(extendedEnd, hardEnd)
          : hardEnd;
        end = Math.max(end, choiceAwareEnd);
      }
      // SOFTM-위치맵: 다음 문제 경계 밖 선택지 후보는 이전 문제 segment를 늘리지 않고 오탐으로 취급 - 2026-06-17
    }
    if (end <= start + 0.045) end = clamp(start + 0.16, start + 0.05, 0.97);
    const primary = {
      page,
      top: clamp(start, 0.020, 0.97),
      bottom: clamp(end, Math.min(0.97, start + 0.05), 0.98),
      left: currentLane.left,
      right: currentLane.right,
      column: currentLane.column,
      source: currentLane.column != null ? "column-segment" : "page-segment",
    };
    const segments = [primary];
    const continuation = buildContinuationSegment(q, currentLane);
    if (continuation) segments.push(continuation);
    out[String(q)] = segments;
  }
  return out;
}
// SOFTM-위치맵: 문제번호 흐름으로 확정한 문제 영역을 저장해 한문제 보기와 연속 2단 문항을 직접 사용하도록 지원 - 2026-06-01

async function detectChoiceAnchorsFromImages(pageDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap = {}, questionColumnBoundsMap = {}, questionSegments = {}, ocrChoiceCandidates = []){
  const mapPath = path.join(pageDir, "choice-map-input.json");
  await fsp.writeFile(mapPath, JSON.stringify({ pageMap, topMap, questionCount, choiceCount, questionLabelMap, questionColumnBoundsMap, questionSegments, ocrChoiceCandidates }), "utf8");
  const script = `
import json, os, re, sys
from PIL import Image
import numpy as np
from scipy import ndimage

page_dir, map_path = sys.argv[1], sys.argv[2]
meta = json.load(open(map_path, "r", encoding="utf-8"))
page_map = meta["pageMap"]
top_map = meta["topMap"]
question_label_map = meta.get("questionLabelMap") or {}
column_bounds_map = meta.get("questionColumnBoundsMap") or {}
segments_map = meta.get("questionSegments") or {}
ocr_choice_candidates = meta.get("ocrChoiceCandidates") or []
question_count = int(meta["questionCount"])
choice_count = max(1, min(5, int(meta["choiceCount"] or 4)))

def page_no_from_name(name, fallback=0):
    matches = re.findall(r'(\\d+)', str(name))
    return int(matches[-1]) if matches else fallback

files = sorted([name for name in os.listdir(page_dir) if name.lower().endswith(".png")], key=lambda name: page_no_from_name(name, 0))

def clamp(value, lo, hi):
    return max(lo, min(hi, value))

def x_template(count, layout, compact=False):
    if compact:
        if layout == "grid":
            return [0.16, 0.52]
        if layout == "vertical":
            return [0.16]
        if layout == "horizontal":
            if count == 5:
                return [0.10, 0.26, 0.42, 0.58, 0.74]
            if count == 4:
                return [0.11, 0.27, 0.45, 0.63]
            return [0.12 + (idx * (0.56 / max(1, count - 1))) for idx in range(count)]
    if layout == "horizontal":
        if count == 5:
            return [0.085, 0.245, 0.405, 0.585, 0.765]
        if count == 4:
            return [0.085, 0.305, 0.525, 0.725] # SOFTM-위치맵: 가로형 4번 보기 기준점을 실제 원형 번호 위치에 맞춰 본문 글자 오탐을 방지 - 2026-05-30
        return [0.085 + (idx * (0.76 / max(1, count - 1))) for idx in range(count)]
    if layout == "grid":
        return [0.085, 0.515]
    return [0.085]

def bounds_for_q(q):
    bounds = column_bounds_map.get(str(q)) or {}
    try:
        left = float(bounds.get("left", 0.0))
        right = float(bounds.get("right", 1.0))
        column = bounds.get("column", None)
        if right > left + 0.10:
            return {
                "left": clamp(left, 0.0, 1.0),
                "right": clamp(right, 0.0, 1.0),
                "column": int(column) if column is not None else None,
            }
    except Exception:
        pass
    return {"left": 0.0, "right": 1.0, "column": None}

def same_lane_q(q, next_q):
    a = bounds_for_q(q)
    b = bounds_for_q(next_q)
    ac = a.get("column")
    bc = b.get("column")
    if ac is not None and bc is not None:
        return ac == bc
    return max(float(a["left"]), float(b["left"])) < min(float(a["right"]), float(b["right"])) - 0.08

def segment_for_q(q, page):
    segments = segments_map.get(str(q)) or []
    if not isinstance(segments, list):
        return None
    for segment in segments:
        try:
            if int(segment.get("page") or 0) != int(page):
                continue
            top = float(segment.get("top"))
            bottom = float(segment.get("bottom"))
            if bottom > top + 0.035:
                return {
                    "top": clamp(top, 0.0, 0.98),
                    "bottom": clamp(bottom, 0.02, 0.99),
                    "left": clamp(float(segment.get("left", 0.0)), 0.0, 1.0),
                    "right": clamp(float(segment.get("right", 1.0)), 0.0, 1.0),
                }
        except Exception:
            continue
    return None

def page_features(image_path):
    im = Image.open(image_path).convert("L")
    arr = np.array(im)
    h, w = arr.shape
    mask = arr < 100
    labels, count = ndimage.label(mask)
    objects = ndimage.find_objects(labels)
    out = []
    for idx, obj in enumerate(objects, start=1):
        if obj is None:
            continue
        ys, xs = obj
        y0, y1 = ys.start, ys.stop
        x0, x1 = xs.start, xs.stop
        bw, bh = x1 - x0, y1 - y0
        if bw < 10 or bw > 62 or bh < 10 or bh > 62:
            continue
        aspect = bw / max(1, bh)
        if aspect < 0.38 or aspect > 1.75:
            continue
        pixels = int(np.sum(labels[obj] == idx))
        fill = pixels / max(1, bw * bh)
        if fill < 0.055 or fill > 0.55:
            continue
        # SOFTM-위치맵: 끊어진 원형 선택지 기호도 이미지 후보로 잡히도록 크기/형태 조건을 완화 - 2026-05-30
        cx = (x0 + x1) / 2 / max(1, w)
        cy = (y0 + y1) / 2 / max(1, h)
        if cx < 0.018 or cx > 0.92 or cy < 0.04 or cy > 0.965:
            continue
        lx0 = max(0, x0 - 34)
        lx1 = max(0, x0 - 5)
        ly0 = max(0, y0 - 3)
        ly1 = min(h, y1 + 3)
        left_density = 0.0
        if lx1 > lx0 and ly1 > ly0:
            left_density = float(np.mean(arr[ly0:ly1, lx0:lx1] < 125))
        out.append({"xRatio": cx, "yRatio": cy, "wRatio": bw / w, "hRatio": bh / h, "fill": fill, "leftDensity": left_density, "aspect": aspect})
    marker_xs = [0.035, 0.085, 0.245, 0.305, 0.405, 0.515, 0.525, 0.585, 0.725, 0.765]
    outline_mask = ndimage.binary_closing(arr < 190, structure=np.ones((2, 2)))
    outline_labels, outline_count = ndimage.label(outline_mask)
    outline_objects = ndimage.find_objects(outline_labels)
    for idx, obj in enumerate(outline_objects, start=1):
        if obj is None:
            continue
        ys, xs = obj
        y0, y1 = ys.start, ys.stop
        x0, x1 = xs.start, xs.stop
        bw, bh = x1 - x0, y1 - y0
        if bw < 18 or bw > 48 or bh < 18 or bh > 48:
            continue
        aspect = bw / max(1, bh)
        if aspect < 0.72 or aspect > 1.28:
            continue
        pixels = int(np.sum(outline_labels[obj] == idx))
        fill = pixels / max(1, bw * bh)
        if fill < 0.075 or fill > 0.24:
            continue
        cx = (x0 + x1) / 2 / max(1, w)
        cy = (y0 + y1) / 2 / max(1, h)
        if cx < 0.018 or cx > 0.92 or cy < 0.04 or cy > 0.965:
            continue
        if min(abs(cx - expected_x) for expected_x in marker_xs) > 0.040:
            continue
        lx0 = max(0, x0 - 34)
        lx1 = max(0, x0 - 5)
        ly0 = max(0, y0 - 3)
        ly1 = min(h, y1 + 3)
        left_density = 0.0
        if lx1 > lx0 and ly1 > ly0:
            left_density = float(np.mean(arr[ly0:ly1, lx0:lx1] < 125))
        out.append({"xRatio": cx, "yRatio": cy, "wRatio": bw / w, "hRatio": bh / h, "fill": fill, "leftDensity": left_density, "source": "anchor-image-outline", "aspect": aspect})
    # SOFTM-위치맵: 얇게 인쇄된 원형 선택지(②/③ 등)가 낮은 임계값에서 조각나면 outline 후보로 복구 - 2026-05-31
    strong = arr < 80
    horizontal_lines = []
    row_density = np.mean(strong, axis=1)
    line_rows = np.where(row_density > 0.34)[0]
    groups = []
    for y in line_rows:
        if not groups or y > groups[-1][1] + 1:
            groups.append([int(y), int(y)])
        else:
            groups[-1][1] = int(y)
    for y0, y1 in groups:
        row = strong[(y0 + y1) // 2]
        best_len = 0
        best_start = 0
        current_len = 0
        current_start = 0
        for idx, value in enumerate(row):
            if value:
                if current_len == 0:
                    current_start = idx
                current_len += 1
                if current_len > best_len:
                    best_len = current_len
                    best_start = current_start
            else:
                current_len = 0
        if best_len / max(1, w) < 0.34:
            continue
        horizontal_lines.append({
            "yRatio": ((y0 + y1) * 0.5) / max(1, h),
            "x0Ratio": best_start / max(1, w),
            "x1Ratio": (best_start + best_len) / max(1, w),
            "runRatio": best_len / max(1, w),
        })
    return {"candidates": out, "horizontalLines": horizontal_lines}

def stimulus_floor_after_start(horizontal_lines, start, end):
    lines = [
        line for line in horizontal_lines
        if line["runRatio"] >= 0.40
        and line["x0Ratio"] <= 0.16
        and line["x1Ratio"] >= 0.72
        and start + 0.012 <= line["yRatio"] <= end - 0.020
    ]
    if len(lines) < 2:
        return None
    floor = max(line["yRatio"] for line in lines)
    if floor <= start + 0.050:
        return None
    return floor
    # SOFTM-위치맵: 지문/표 박스의 긴 가로선을 감지해 박스 내부 글자를 선택지 후보에서 제외 - 2026-05-30

def rows_from(candidates):
    rows = []
    for item in sorted(candidates, key=lambda row: (row["yRatio"], row["xRatio"])):
        target = None
        for row in rows:
            if abs(row["y"] - item["yRatio"]) <= 0.012:
                target = row
                break
        if target is None:
            target = {"y": item["yRatio"], "items": []}
            rows.append(target)
        target["items"].append(item)
        target["y"] = sum(v["yRatio"] for v in target["items"]) / len(target["items"])
    return rows

def row_has_question_number_prefix(row):
    left = [item for item in row.get("items", []) if 0.060 <= item["xRatio"] <= 0.118]
    if len(left) < 2:
        return False
    left = sorted(left, key=lambda item: item["xRatio"])
    span = left[-1]["xRatio"] - left[0]["xRatio"]
    if span < 0.008:
        return False
    has_dense_digit = any(item.get("fill", 0) > 0.28 and item.get("wRatio", 0) < 0.012 and item.get("hRatio", 0) < 0.016 for item in left)
    return has_dense_digit and span <= 0.024
    # SOFTM-위치맵: 77.처럼 분리된 좁은 문제번호 숫자 행은 원형 선택지 행과 구분 - 2026-05-30

def nearest(row_items, expected_x, used, max_dx=0.06, compact=False):
    best = None
    best_score = 999
    for idx, item in enumerate(row_items):
        if idx in used:
            continue
        dx = abs(item["xRatio"] - expected_x)
        if dx > max_dx:
            continue
        if compact:
            aspect = float(item.get("aspect", 1.0) or 1.0)
            fill = float(item.get("fill", 0.0) or 0.0)
            if aspect < 0.50 or aspect > 1.65:
                continue
            if fill < 0.08 or fill > 0.55:
                continue
        source = str(item.get("source", ""))
        left_density_limit = 0.16 if ("outline" in source or "ocr-token" in source) else 0.070
        if item.get("leftDensity", 0) > left_density_limit:
            continue
        if not compact and item["xRatio"] < 0.13 and item.get("fill", 0) > 0.34 and item.get("wRatio", 0) < 0.012 and item.get("hRatio", 0) < 0.016:
            continue
        # SOFTM-위치맵: 페이지 첫 문항의 5. 같은 좁고 진한 문제번호 숫자를 원형 보기 ①로 오인하지 않도록 제외 - 2026-05-30
        # SOFTM-문항앵커: 2단 compact 좌표계에서는 실제 ①이 왼쪽에 바짝 붙어 같은 조건에 걸리므로 기대 위치 매칭을 우선 - 2026-06-17
        shape_penalty = abs((item["wRatio"] / max(0.0001, item["hRatio"])) - 1.0) * 0.004
        score = dx + shape_penalty + (0.015 if item["fill"] > 0.42 else 0) + (item.get("leftDensity", 0) * 0.05)
        if score < best_score:
            best = (idx, item, dx)
            best_score = score
    return best

def complete_leading_vertical_rows(found_rows, choice_count, question_start=None):
    if question_start is None or len(found_rows) < 3 or len(found_rows) >= choice_count:
        return found_rows
    try:
        start = float(question_start)
    except Exception:
        return found_rows
    gaps = [
        found_rows[idx + 1][0] - found_rows[idx][0]
        for idx in range(len(found_rows) - 1)
        if found_rows[idx + 1][0] > found_rows[idx][0]
    ]
    if not gaps:
        return found_rows
    gap = sorted(gaps)[len(gaps) // 2]
    if gap < 0.018 or gap > 0.060:
        return found_rows
    if max(abs(value - gap) for value in gaps) > max(0.006, gap * 0.36):
        return found_rows
    first_y, first_item, first_dx = found_rows[0]
    if first_y - start <= max(0.032, gap * 1.18):
        return found_rows
    inferred_y = first_y - gap
    if inferred_y <= start + 0.002 or inferred_y >= first_y - 0.010:
        return found_rows
    item = dict(first_item)
    item["yRatio"] = inferred_y
    item["source"] = f'{item.get("source", "anchor-image")}-inferred-leading'
    item["inferred"] = True
    return [(inferred_y, item, first_dx + 0.012)] + found_rows
    # SOFTM-위치맵: 세로형 보기에서 ①만 이미지 후보에서 빠지고 ②③④가 안정적으로 잡힌 경우 번호를 당겨 붙이지 않고 ① 위치를 간격으로 복원 - 2026-05-31

def complete_trailing_vertical_rows(found_rows, choice_count, question_end=None):
    if len(found_rows) < 3 or len(found_rows) >= choice_count:
        return found_rows
    gaps = [
        found_rows[idx + 1][0] - found_rows[idx][0]
        for idx in range(len(found_rows) - 1)
        if found_rows[idx + 1][0] > found_rows[idx][0]
    ]
    if not gaps:
        return found_rows
    recent_gap = gaps[-1]
    median_gap = sorted(gaps)[len(gaps) // 2]
    gap = min(recent_gap, median_gap)
    if gap < 0.012 or gap > 0.075:
        return found_rows
    last_y, last_item, last_dx = found_rows[-1]
    inferred_y = last_y + gap
    try:
        if question_end is not None and inferred_y > float(question_end) + 0.024:
            return found_rows
    except Exception:
        pass
    if inferred_y <= last_y + 0.010 or inferred_y > 0.94:
        return found_rows
    item = dict(last_item)
    item["yRatio"] = inferred_y
    item["source"] = f'{item.get("source", "anchor-image")}-inferred-trailing'
    item["inferred"] = True
    return found_rows + [(inferred_y, item, last_dx + 0.014)]
    # SOFTM-위치맵: 세로형 보기에서 마지막 보기 원형이 약하게 인쇄되어 빠진 경우 다음 문제 영역을 넘지 않는 선에서 마지막 보기를 복원 - 2026-06-01

def score_horizontal(rows, choice_count, expected_y, question_start=None, compact=False):
    best = None
    xs = x_template(choice_count, "horizontal", compact)
    max_dx = 0.075 if compact else 0.065
    for row in rows:
        min_horizontal_depth = 0.022 if compact and raw_band < 0.090 else 0.045 # SOFTM-위치맵: 짧은 2단 문항은 선택지 행이 문제번호와 가까워도 가로형 후보로 유지 - 2026-06-16
        if question_start is not None and row["y"] - float(question_start) < min_horizontal_depth:
            continue
        if row_has_question_number_prefix(row):
            continue
        # SOFTM-위치맵: 문제번호가 포함된 제목 행을 가로형 ①~④ 보기 행으로 채택하지 않도록 제외 - 2026-05-30
        used = set()
        found_by_choice = {}
        dx_sum = 0
        for choice, x in enumerate(xs, start=1):
            found = nearest(row["items"], x, used, max_dx, compact)
            if not found:
                continue
            idx, item, dx = found
            used.add(idx)
            dx_sum += dx
            found_by_choice[choice] = item
        if len(found_by_choice) < max(2, min(choice_count, 3)):
            continue
        anchors = []
        for choice, x in enumerate(xs, start=1):
            if choice in found_by_choice:
                anchors.append((choice, found_by_choice[choice]))
        y_penalty = abs(row["y"] - expected_y)
        depth = row["y"] - float(question_start) if question_start is not None else 0.0
        lower_row_bonus = min(0.36, max(0.0, depth - 0.070)) * 28
        early_stem_penalty = 5.5 if depth < 0.095 and len(found_by_choice) >= choice_count else 0
        score = (len(found_by_choice) * 12) - (dx_sum * 45) - (y_penalty * 18) + lower_row_bonus - early_stem_penalty
        if best is None or score > best["score"]:
            best = {"score": score, "anchors": anchors, "layout": "horizontal", "foundCount": len(found_by_choice), "yDistance": y_penalty, "firstY": min(anchor[1]["yRatio"] for anchor in anchors), "lastY": max(anchor[1]["yRatio"] for anchor in anchors)}
    return best

def score_grid(rows, choice_count, expected_y, question_start=None, compact=False):
    if choice_count < 4:
        return None
    best = None
    sorted_rows = sorted(rows, key=lambda row: row["y"])
    xs = x_template(choice_count, "grid", compact)
    left_x = xs[0]
    right_x = xs[1] if len(xs) > 1 else 0.515
    min_gap = 0.010 if compact else 0.018
    max_gap = 0.185 if compact else 0.145
    max_dx = 0.075 if compact else 0.035
    for i, top in enumerate(sorted_rows):
        for bottom in sorted_rows[i + 1:]:
            gap = bottom["y"] - top["y"]
            if gap < min_gap:
                continue
            if gap > max_gap: # SOFTM-위치맵: 보기 2행 간격이 큰 문제도 그리드 후보로 유지 - 2026-05-30
                break
            if question_start is not None and top["y"] - float(question_start) < 0.045 and gap > 0.045 and bottom["y"] - float(question_start) > 0.080:
                continue
            # SOFTM-위치맵: 바로 아래 문제 제목을 2행 그리드 하단 선택지로 섞는 오탐을 제외 - 2026-05-30
            used_top = set()
            used_bottom = set()
            t_left = nearest(top["items"], left_x, used_top, max_dx, compact)
            if t_left: used_top.add(t_left[0])
            t_right = nearest(top["items"], right_x, used_top, max_dx, compact)
            if t_right: used_top.add(t_right[0])
            b_left = nearest(bottom["items"], left_x, used_bottom, max_dx, compact)
            if b_left: used_bottom.add(b_left[0])
            b_right = nearest(bottom["items"], right_x, used_bottom, max_dx, compact)
            found = [v for v in [t_left, t_right, b_left, b_right] if v]
            if len(found) < 4:
                continue
            anchors = [
                (1, t_left[1]),
                (2, t_right[1]),
                (3, b_left[1]),
                (4, b_right[1]),
            ]
            if not compact and any(anchor[0] in (1, 3) and anchor[1]["xRatio"] < 0.092 for anchor in anchors):
                continue
            # SOFTM-위치맵: 왼쪽 열 후보가 페이지 가장자리 본문 글자에 붙으면 가짜 2행 선택지로 보고 제외 - 2026-05-30
            dx_sum = sum(v[2] for v in found)
            y_mid = (top["y"] + bottom["y"]) * 0.5
            y_distance = abs(y_mid - expected_y)
            score = (len(found) * 15) - (dx_sum * 45) - (y_distance * 10) - (abs(gap - 0.036) * 18)
            if best is None or score > best["score"]:
                best = {"score": score, "anchors": anchors[:choice_count], "layout": "grid", "foundCount": len(found), "yDistance": y_distance, "gap": gap, "compact": compact, "firstY": min(anchor[1]["yRatio"] for anchor in anchors[:choice_count]), "lastY": max(anchor[1]["yRatio"] for anchor in anchors[:choice_count])}
    return best

def score_vertical(rows, choice_count, expected_y, question_start=None, question_end=None, compact=False):
    x = x_template(choice_count, "vertical", compact)[0]
    max_dx = 0.055 if compact else 0.035
    min_depth = 0.010 if compact else 0.012
    found_rows = []
    for row in sorted(rows, key=lambda row: row["y"]):
        if question_start is not None and row["y"] < float(question_start) + min_depth:
            continue
        found = nearest(row["items"], x, set(), max_dx, compact)
        if not found:
            continue
        _, item, dx = found
        found_rows.append((row["y"], item, dx))
    min_required = max(2, min(choice_count, 3))
    if len(found_rows) < min_required:
        return None
    found_rows = found_rows[:choice_count]
    choice_rows = None
    if choice_count == 4 and len(found_rows) == 3:
        gaps = [found_rows[i + 1][0] - found_rows[i][0] for i in range(len(found_rows) - 1)]
        positive_gaps = [gap for gap in gaps if gap > 0]
        if len(positive_gaps) == 2:
            small_gap = min(positive_gaps)
            large_gap = max(positive_gaps)
            large_idx = gaps.index(large_gap)
            if 0.024 <= small_gap <= 0.070 and large_gap >= small_gap * 1.55 and large_gap <= small_gap * 2.75:
                choice_rows = []
                observed_choice = 1
                for idx, row in enumerate(found_rows):
                    choice_rows.append((observed_choice, row))
                    if idx == large_idx:
                        before = row
                        after = found_rows[idx + 1]
                        inferred = dict(before[1])
                        inferred["yRatio"] = clamp((before[0] + after[0]) * 0.5, 0.02, 0.98)
                        inferred["xRatio"] = clamp((float(before[1].get("xRatio", 0)) + float(after[1].get("xRatio", 0))) * 0.5, 0.0, 1.0)
                        inferred["source"] = f"{inferred.get('source', 'anchor-image')}-inferred-middle"
                        inferred["inferred"] = True
                        choice_rows.append((observed_choice + 1, (inferred["yRatio"], inferred, max(before[2], after[2]) + 0.020)))
                        observed_choice += 2
                    else:
                        observed_choice += 1
                choice_rows = choice_rows[:choice_count]
    if choice_rows is None:
        found_rows = complete_trailing_vertical_rows(found_rows, choice_count, question_end)
        choice_rows = [(idx + 1, row) for idx, row in enumerate(found_rows)]
    start_choice = 1
    anchors = [(choice, item) for choice, (_, item, _) in choice_rows]
    if len(anchors) < min_required:
        return None
    # SOFTM-위치맵: 부분 세로형 선택지는 번호를 임의로 뒤로 밀지 않는다. ①을 ②로 오표시하는 것이 누락보다 위험하다 - 2026-06-01
    y_distance = abs(((anchors[0][1]["yRatio"] + anchors[-1][1]["yRatio"]) * 0.5) - expected_y)
    score_rows = [row for _, row in choice_rows]
    score = (len(score_rows) * 12) - (sum(item[2] for item in score_rows) * 40) - (y_distance * 8)
    return {"score": score, "anchors": anchors, "layout": "vertical", "foundCount": len(score_rows), "yDistance": y_distance, "firstY": min(anchor[1]["yRatio"] for anchor in anchors), "lastY": max(anchor[1]["yRatio"] for anchor in anchors), "compact": compact}

def score_outline_vertical(rows, choice_count, expected_y, question_start=None, question_end=None, compact=False):
    expected_x = x_template(choice_count, "vertical", compact)[0]
    max_dx = 0.055 if compact else 0.035
    min_depth = 0.010 if compact else 0.012
    found_rows = []
    for row in sorted(rows, key=lambda row: row["y"]):
        if question_start is not None and row["y"] < float(question_start) + min_depth:
            continue
        best = None
        best_dx = 999
        for item in row.get("items", []):
            if "outline" not in str(item.get("source", "")):
                continue
            dx = abs(item["xRatio"] - expected_x)
            if dx > max_dx:
                continue
            if dx < best_dx:
                best = item
                best_dx = dx
        if best is not None:
            found_rows.append((row["y"], best, best_dx))
    if len(found_rows) < 3:
        return None
    found_rows = found_rows[:choice_count]
    choice_rows = None
    if choice_count == 4 and len(found_rows) == 3:
        gaps = [found_rows[i + 1][0] - found_rows[i][0] for i in range(len(found_rows) - 1)]
        positive_gaps = [gap for gap in gaps if gap > 0]
        if len(positive_gaps) == 2:
            small_gap = min(positive_gaps)
            large_gap = max(positive_gaps)
            large_idx = gaps.index(large_gap)
            if 0.024 <= small_gap <= 0.070 and large_gap >= small_gap * 1.55 and large_gap <= small_gap * 2.75:
                choice_rows = []
                observed_choice = 1
                for idx, row in enumerate(found_rows):
                    choice_rows.append((observed_choice, row))
                    if idx == large_idx:
                        before = row
                        after = found_rows[idx + 1]
                        inferred = dict(before[1])
                        inferred["yRatio"] = clamp((before[0] + after[0]) * 0.5, 0.02, 0.98)
                        inferred["xRatio"] = clamp((float(before[1].get("xRatio", 0)) + float(after[1].get("xRatio", 0))) * 0.5, 0.0, 1.0)
                        inferred["source"] = f"{inferred.get('source', 'anchor-image')}-inferred-middle"
                        inferred["inferred"] = True
                        choice_rows.append((observed_choice + 1, (inferred["yRatio"], inferred, max(before[2], after[2]) + 0.020)))
                        observed_choice += 2
                    else:
                        observed_choice += 1
                choice_rows = choice_rows[:choice_count]
    if choice_rows is None:
        found_rows = complete_trailing_vertical_rows(found_rows, choice_count, question_end)
        choice_rows = [(idx + 1, row) for idx, row in enumerate(found_rows)]
    start_choice = 1
    anchors = [(choice, item) for choice, (_, item, _) in choice_rows]
    y_distance = abs(((anchors[0][1]["yRatio"] + anchors[-1][1]["yRatio"]) * 0.5) - expected_y)
    score_rows = [row for _, row in choice_rows]
    score = (len(score_rows) * 13) - (sum(item[2] for item in score_rows) * 44) - (y_distance * 8)
    return {"score": score, "anchors": anchors, "layout": "vertical", "foundCount": len(score_rows), "yDistance": y_distance, "firstY": min(anchor[1]["yRatio"] for anchor in anchors), "lastY": max(anchor[1]["yRatio"] for anchor in anchors), "outlineVertical": True, "compact": compact}
    # SOFTM-위치맵: 세로형 원형 선택지 일부가 확실하면 오른쪽 본문 글자를 섞은 완전 그리드보다 부분 세로형 후보로 검증 - 2026-05-31

def valid_layout(item, choice_count):
    if not item:
        return False
    if item.get("titleLinePenalty") and item.get("layout") in ("horizontal", "grid"):
        return False
    # SOFTM-위치맵: 문제 제목줄에 붙은 가로/그리드 후보는 보기로 확정하지 않고 미검출 처리 - 2026-06-01
    count = len(item["anchors"])
    xs = [anchor[1]["xRatio"] for anchor in item["anchors"]]
    ys = [anchor[1]["yRatio"] for anchor in item["anchors"]]
    x_span = max(xs) - min(xs)
    y_span = max(ys) - min(ys)
    if item.get("layout") == "horizontal":
        return count >= choice_count and x_span > 0.30 and y_span < 0.04
    # SOFTM-위치맵: 가로형 선택지는 일부만 잡히면 본문 글자를 보기로 오판하는 경우가 많아 완전 검출만 인정 - 2026-05-30
    if item.get("layout") == "grid":
        if item.get("compact"):
            return count >= min(choice_count, 4) and x_span > 0.16 and y_span > 0.008
        return count >= min(choice_count, 4) and x_span > 0.32 and y_span > 0.018
    if item.get("layout") == "vertical":
        min_vertical_span = 0.030 if item.get("compact") else 0.045
        return count >= max(2, min(choice_count, 3)) and x_span < 0.09 and y_span > min_vertical_span and y_span < 0.22
    return False

def pick_layout(horizontal, grid, vertical, choice_count, prefer_grid=False):
    h_ok = valid_layout(horizontal, choice_count)
    g_ok = valid_layout(grid, choice_count)
    v_ok = valid_layout(vertical, choice_count)
    h_count = int(horizontal.get("foundCount") or len(horizontal.get("anchors", []))) if h_ok else 0
    g_count = int(grid.get("foundCount") or len(grid.get("anchors", []))) if g_ok else 0
    v_count = int(vertical.get("foundCount") or len(vertical.get("anchors", []))) if v_ok else 0
    h_dist = float(horizontal.get("yDistance", 1.0)) if h_ok else 1.0
    g_dist = float(grid.get("yDistance", 1.0)) if g_ok else 1.0
    v_dist = float(vertical.get("yDistance", 1.0)) if v_ok else 1.0
    v_strong = v_ok and v_count >= max(3, min(choice_count, 3))
    vertical_guard = 0.070 if v_strong else 0.030
    v_span = float(vertical.get("lastY", 0.0)) - float(vertical.get("firstY", 0.0)) if v_ok else 0.0
    full_vertical = v_ok and v_count >= choice_count and v_span >= 0.038
    compact_grid_competes = prefer_grid and g_ok and v_ok and g_count >= choice_count and float(grid.get("firstY", 1.0)) <= float(vertical.get("firstY", 1.0)) + 0.020 and float(grid.get("gap", 1.0)) <= 0.075
    if full_vertical and not compact_grid_competes and (not h_ok or float(vertical.get("firstY", 1.0)) <= float(horizontal.get("firstY", 1.0)) + 0.085) and (not g_ok or float(vertical.get("firstY", 1.0)) <= float(grid.get("firstY", 1.0)) + 0.030):
        return vertical
    # SOFTM-위치맵: 세로형 ①~④가 모두 잡히면 한 줄 본문 글자 조합보다 세로 선택지를 우선 - 2026-05-31
    if prefer_grid and g_ok and g_count >= choice_count and (not h_ok or g_dist <= h_dist + 0.150) and (not v_ok or g_dist <= v_dist + 0.120):
        return grid
    # SOFTM-위치맵: 지문/표 박스 뒤 4지선다 문항은 한 줄 글자 오판보다 완전한 2행 선택지를 우선 - 2026-05-30
    if v_ok and v_count >= choice_count and v_span > 0.070 and (not g_ok or float(vertical.get("firstY", 1.0)) <= float(grid.get("firstY", 1.0)) + 0.035):
        return vertical
    # SOFTM-위치맵: ①~④가 왼쪽 열에 완전하게 잡히면 오른쪽 본문 글자를 섞은 가짜 2행 그리드보다 세로형을 우선 - 2026-05-30
    if h_ok and h_count >= choice_count and not g_ok and v_ok and v_count < choice_count and float(horizontal.get("firstY", 1.0)) <= float(vertical.get("firstY", 1.0)) + 0.040:
        return horizontal
    # SOFTM-위치맵: 76번처럼 완전한 한 줄 선택지가 잡혔으면 문제번호와 다음 문제번호를 섞은 불완전 세로 후보보다 가로형을 우선 - 2026-05-30
    if g_ok and h_ok and g_count >= choice_count and h_count >= choice_count and abs(float(grid.get("firstY", 1.0)) - float(horizontal.get("firstY", 1.0))) <= 0.018 and float(grid.get("gap", 1.0)) <= 0.060 and g_dist <= h_dist + 0.080:
        return grid
    # SOFTM-위치맵: 짧은 간격의 완전한 2행 보기(①②/③④)는 첫 행 글자 조합 가로형보다 우선 - 2026-05-30
    if v_strong and h_ok and v_span > 0.045 and float(vertical.get("firstY", 1.0)) < float(horizontal.get("firstY", 1.0)) - 0.024 and v_dist <= h_dist + 0.140:
        return vertical
    # SOFTM-위치맵: 세로 선택지 일부가 먼저 잡힌 경우 같은 줄 본문 글자를 가로 선택지로 오판하지 않도록 세로형 우선 - 2026-05-30
    if v_strong and v_count < choice_count and g_ok and g_count >= choice_count and abs(float(vertical.get("firstY", 1.0)) - float(grid.get("firstY", 1.0))) <= 0.018 and float(vertical.get("lastY", 0.0)) >= float(grid.get("lastY", 0.0)) - 0.014:
        return vertical
    if v_strong and v_count < choice_count and h_ok and h_count >= choice_count and abs(float(vertical.get("firstY", 1.0)) - float(horizontal.get("firstY", 1.0))) <= 0.018 and float(vertical.get("lastY", 0.0)) >= float(horizontal.get("lastY", 0.0)) - 0.014:
        return vertical
    # SOFTM-위치맵: 2025처럼 세로 보기 3개가 확실한데 오른쪽 본문 조각을 섞어 완전 그리드/가로형으로 오판하면 부분 세로형을 우선하고 누락으로 남김 - 2026-05-31
    # SOFTM-위치맵: 세로형 4개가 완전하면 같은 행 본문 글자를 가로 선택지로 오판하지 않도록 세로형 우선 - 2026-05-30
    if v_ok and v_count >= choice_count and v_span > 0.070 and (not h_ok or float(vertical.get("firstY", 1.0)) < float(horizontal.get("firstY", 1.0)) - 0.040 or float(vertical.get("lastY", 0.0)) > float(horizontal.get("lastY", 0.0)) + 0.035) and (not g_ok or float(vertical.get("firstY", 1.0)) <= float(grid.get("firstY", 1.0)) + 0.018):
        return vertical
    # SOFTM-위치맵: 한 줄 선택지 후보가 먼저 3개 이상 잡히면 다음 문제를 섞은 2행 그리드보다 가로형 우선 - 2026-05-30
    if h_ok and h_count >= max(3, min(choice_count, 3)) and (not g_ok or float(horizontal.get("firstY", 1.0)) <= float(grid.get("firstY", 1.0)) + 0.012):
        return horizontal
    # SOFTM-위치맵: 2행 선택지 4개가 모두 잡힌 경우 왼쪽 열만 보고 세로형으로 오판하지 않도록 그리드 우선 - 2026-05-30
    if g_ok and g_count >= choice_count and (not v_ok or (v_count < choice_count and float(grid.get("firstY", 1.0)) <= float(vertical.get("firstY", 1.0)) + 0.018)):
        return grid
    # SOFTM-위치맵: 왼쪽 열에 3개 이상 세로 후보가 있으면 본문 글자를 오른쪽 열로 오인한 가짜 그리드/가로형보다 세로형 우선 - 2026-05-30
    if v_strong and (not h_ok or float(vertical.get("firstY", 1.0)) < float(horizontal.get("firstY", 1.0)) - 0.010 or v_dist <= h_dist + 0.080) and (not g_ok or float(vertical.get("firstY", 1.0)) < float(grid.get("firstY", 1.0)) - 0.010 or v_dist <= g_dist + 0.065):
        return vertical
    # SOFTM-위치맵: 위/아래 2행 선택지에서 아래 행만 가로형으로 오판하지 않도록 더 이른 첫 행의 완전 그리드를 우선 - 2026-05-30
    if g_ok and h_ok and g_count >= choice_count and h_count >= choice_count and float(grid.get("firstY", 1.0)) < float(horizontal.get("firstY", 1.0)) - 0.018 and g_dist <= h_dist + 0.050:
        return grid
    # SOFTM-위치맵: 2행 간격이 충분한 선택지는 한 행의 본문 글자 후보를 묶은 가로형보다 그리드를 우선 - 2026-05-30
    if g_ok and h_ok and g_count >= choice_count and float(grid.get("gap", 0.0)) > 0.060 and g_dist <= h_dist + 0.070:
        return grid
    # SOFTM-위치맵: ①~④ 세로 시퀀스가 가로 후보보다 먼저 시작하면 하단 텍스트 줄을 가로 선택지로 오판하지 않도록 세로형 우선 - 2026-05-30
    if v_ok and h_ok and v_count >= choice_count and float(vertical.get("firstY", 1.0)) < float(horizontal.get("firstY", 1.0)) - 0.050 and v_dist <= h_dist + 0.090:
        return vertical
    # SOFTM-위치맵: ①~④가 한 줄에 모두 잡힌 경우 지문 박스 내부 후보가 섞인 2행 그리드보다 가로형을 우선 - 2026-05-30
    if h_ok and h_count >= choice_count and (not g_ok or h_dist <= g_dist + 0.035) and (not v_ok or h_dist + vertical_guard < v_dist):
        return horizontal
    # SOFTM-위치맵: 완전한 세로 선택지보다 아래쪽 본문 글자를 조합한 가짜 2행 그리드가 선택되지 않도록 시작 위치를 비교 - 2026-05-30
    if v_ok and v_count >= choice_count and g_ok and float(grid.get("firstY", 1.0)) > float(vertical.get("firstY", 1.0)) + 0.022:
        return vertical
    # SOFTM-위치맵: 2행 배치가 완전하게 감지되면 다음 문제번호 후보를 섞은 세로형 오판보다 그리드를 우선 - 2026-05-30
    if g_ok and g_count >= choice_count and (not v_ok or g_dist <= v_dist + 0.025):
        return grid
    if v_strong and (not g_ok or v_dist + 0.010 < g_dist):
        return vertical
    if g_ok:
        return grid
    if h_ok:
        return horizontal
    if v_ok:
        return vertical
    return None

by_page = {}
for fallback_page_no, name in enumerate(files, start=1):
    page_no = page_no_from_name(name, fallback_page_no)
    by_page[page_no] = page_features(os.path.join(page_dir, name))

ocr_by_page = {}
for item in ocr_choice_candidates:
    try:
        page = int(item.get("page") or 0)
        if page <= 0:
            continue
        ocr_by_page.setdefault(page, []).append({
            "xRatio": float(item.get("xRatio")),
            "yRatio": float(item.get("yRatio")),
            "wRatio": max(0.006, float(item.get("wRatio") or 0.010)),
            "hRatio": max(0.008, float(item.get("hRatio") or 0.012)),
            "fill": 0.11,
            "leftDensity": 0.0,
            "source": "anchor-ocr-token",
            "ocrChoice": int(item.get("choice") or 0),
            "aspect": 1.0,
        })
    except Exception:
        continue

result = {}
for q in range(1, question_count + 1):
    try:
        page = int(page_map[q])
        start = float(top_map[q])
    except Exception:
        continue
    current_bounds = bounds_for_q(q)
    segment = segment_for_q(q, page)
    if segment is not None:
        start = max(start, float(segment["top"]))
    end = None
    page_tail = False
    next_label_anchor = {}
    if segment is not None:
        end = float(segment["bottom"])
    if end is None:
        for next_q in range(q + 1, question_count + 1):
            try:
                if int(page_map[next_q]) != page:
                    break
                if not same_lane_q(q, next_q):
                    continue
                next_top = float(top_map[next_q])
            except Exception:
                continue
            if next_top > start + 0.035:
                end = next_top
                next_label_anchor = question_label_map.get(str(next_q)) or {}
                if next_label_anchor and int(next_label_anchor.get("page") or 0) == page:
                    try:
                        next_label_y = float(next_label_anchor.get("yRatio"))
                        end = max(end, max(start + 0.035, next_label_y - 0.018))
                    except Exception:
                        pass
                break
    if end is None:
        end = min(0.94, start + 0.34)
        page_tail = True
    raw_band = max(0.02, end - start)
    band = max(0.08, min(0.38, raw_band))
    low = start + max(0.012, min(0.042, raw_band * 0.10))
    high = min(0.94, end - 0.004)
    if page_tail:
        high = min(0.94, max(high, end))
        low = max(0.04, min(low, start + 0.004))
    # SOFTM-위치맵: 페이지 마지막 문제는 다음 문제 시작점이 없어 하단 선택지가 잘리지 않도록 검색 하단을 확장 - 2026-05-30
    if raw_band < 0.10:
        high = min(0.94, end + min(0.036, max(0.018, raw_band * 0.35)))
        low = max(0.04, start + max(0.012, raw_band * 0.08))
    # SOFTM-위치맵: 문제 시작점 보간이 짧게 잡힌 경우 선택지 하단 행이 잘리지 않도록 이미지 검색 밴드를 완화 - 2026-05-30
    expected_horizontal_y = clamp(start + max(0.030, min(0.060, raw_band * 0.32)), low, high)
    expected_grid_y = clamp(start + max(0.050, min(0.105, raw_band * 0.50)), low, high)
    expected_vertical_y = clamp(start + max(0.035, min(0.120, raw_band * 0.55)), low, high)
    # SOFTM-위치맵: 가로/그리드/세로 선택지의 일반적인 시작 위치가 달라 배치별 기대 높이를 분리 - 2026-05-30
    page_feature = by_page.get(page, {"candidates": [], "horizontalLines": []})
    column_bounds = column_bounds_map.get(str(q)) or {}
    col_left = None
    col_right = None
    try:
        if column_bounds and int(column_bounds.get("page") or page) == page:
            left_candidate = float(current_bounds.get("left", column_bounds.get("left")))
            right_candidate = float(current_bounds.get("right", column_bounds.get("right")))
            if right_candidate > left_candidate + 0.10:
                col_left = max(0.0, min(1.0, left_candidate))
                col_right = max(0.0, min(1.0, right_candidate))
    except Exception:
        col_left = None
        col_right = None
    compact_bounds = bool(col_left is not None and col_right is not None and (col_right - col_left) < 0.86)
    if compact_bounds and end > 0.93:
        high = min(0.965, max(high, end - 0.002))
    box_floor = stimulus_floor_after_start(page_feature.get("horizontalLines", []), start, end)
    box_floor_low = None
    if box_floor is not None:
        low = max(low, min(high - 0.018, box_floor + 0.012))
        box_floor_low = low
        expected_horizontal_y = max(expected_horizontal_y, min(high, low + 0.020))
        expected_grid_y = max(expected_grid_y, min(high, low + 0.035))
        expected_vertical_y = max(expected_vertical_y, min(high, low + 0.035))
    label_anchor = question_label_map.get(str(q)) or {}
    next_question_start = None
    try:
        if next_label_anchor and int(next_label_anchor.get("page") or 0) == page:
            next_question_start = float(next_label_anchor.get("yRatio"))
    except Exception:
        next_question_start = None
    if next_question_start is None and compact_bounds:
        for next_q_for_label in range(q + 1, question_count + 1):
            try:
                if int(page_map[next_q_for_label]) != page:
                    break
                if not same_lane_q(q, next_q_for_label):
                    continue
                candidate_next_label = question_label_map.get(str(next_q_for_label)) or {}
                if candidate_next_label and int(candidate_next_label.get("page") or 0) == page:
                    next_label_anchor = candidate_next_label
                    next_question_start = float(candidate_next_label.get("yRatio"))
                    break
            except Exception:
                continue
    if next_question_start is not None:
        high = min(high, max(low, float(next_question_start) - 0.001))
    elif segment is not None:
        high = min(high, max(low, float(segment.get("bottom") or high) - 0.001))
    # SOFTM-위치맵: 선택지 후보 탐색은 현재 문제 segment 하단을 hard boundary로 사용해 다음 문제 보기/본문을 끌어오지 않음 - 2026-06-17
    choice_question_start = start
    try:
        label_source = str(label_anchor.get("source") or "").lower() if label_anchor else ""
        label_is_inferred = bool(label_anchor.get("inferred")) or label_source.startswith("inferred-")
        if label_anchor and int(label_anchor.get("page") or 0) == page and not label_is_inferred:
            choice_question_start = max(choice_question_start, float(label_anchor.get("yRatio") or choice_question_start))
    except Exception:
        choice_question_start = start
    current_label_exclusion_dy = 0.014 if not compact_bounds else 0.018 # SOFTM-위치맵: 문제번호 바로 아래 붙은 ① 보기 불렛이 라벨 근접 제외에 함께 지워지지 않게 y 범위를 축소 - 2026-06-17
    next_label_exclusion_dy = 0.024 if not compact_bounds else 0.028 # SOFTM-위치맵: 다음 문제번호 오탐은 계속 차단하되 현재 문제 첫 보기보다 좁게 분리 - 2026-06-17
    label_exclusion_dx = 0.018 if compact_bounds else 0.045
    # SOFTM-위치맵: inferred 문제 라벨은 실제 시작점보다 아래로 밀릴 수 있어 선택지 검색 시작점을 올려 잡지 않음 - 2026-06-17
    # SOFTM-위치맵: 첫 선택지 누락 판단은 crop 시작선이 아니라 실제 문제번호 라벨 기준으로 계산 - 2026-06-01
    page_candidates = list(page_feature.get("candidates", [])) + list(ocr_by_page.get(page, []))
    candidates = [
        item for item in page_candidates
        if low <= item["yRatio"] <= high
        and (col_left is None or (item["xRatio"] >= col_left and item["xRatio"] <= col_right))
        and not (compact_bounds and next_question_start is not None and item["yRatio"] >= next_question_start - 0.006)
        and not (item["xRatio"] < 0.13 and item["yRatio"] < start + 0.014)
        and not (
            label_anchor
            and int(label_anchor.get("page") or 0) == page
            and abs(item["xRatio"] - float(label_anchor.get("xRatio") or -1)) <= label_exclusion_dx
            and abs(item["yRatio"] - float(label_anchor.get("yRatio") or -1)) <= current_label_exclusion_dy
        )
        and not (
            next_label_anchor
            and int(next_label_anchor.get("page") or 0) == page
            and abs(item["xRatio"] - float(next_label_anchor.get("xRatio") or -1)) <= label_exclusion_dx
            and abs(item["yRatio"] - float(next_label_anchor.get("yRatio") or -1)) <= next_label_exclusion_dy
        )
    ]
    if col_left is not None and col_right is not None and col_right > col_left + 0.10 and (col_right - col_left) < 0.86:
      normalized_candidates = []
      for item in candidates:
          local = dict(item)
          local["fullXRatio"] = float(item.get("xRatio") or 0)
          local["xRatio"] = clamp((local["fullXRatio"] - col_left) / max(0.001, col_right - col_left), 0.0, 1.0)
          normalized_candidates.append(local)
      candidates = normalized_candidates
    segment_bullet_high = min(0.965, end - 0.001)
    if next_question_start is not None:
        segment_bullet_high = min(segment_bullet_high, float(next_question_start) - 0.001)
    segment_bullet_high = max(segment_bullet_high, low)
    segment_bullet_low = max(choice_question_start + 0.014, start + 0.012) # SOFTM-위치맵: 문제번호 바로 아래 붙은 첫 보기 불렛을 후보 탐색 하한에서 자르지 않음 - 2026-06-17
    segment_bullet_candidates = [
        item for item in page_candidates
        if segment_bullet_low <= item["yRatio"] <= segment_bullet_high
        and (col_left is None or (item["xRatio"] >= col_left and item["xRatio"] <= col_right))
        and not (
            label_anchor
            and int(label_anchor.get("page") or 0) == page
            and abs(item["xRatio"] - float(label_anchor.get("xRatio") or -1)) <= label_exclusion_dx
            and abs(item["yRatio"] - float(label_anchor.get("yRatio") or -1)) <= current_label_exclusion_dy
        )
        and not (
            next_label_anchor
            and int(next_label_anchor.get("page") or 0) == page
            and abs(item["xRatio"] - float(next_label_anchor.get("xRatio") or -1)) <= label_exclusion_dx
            and abs(item["yRatio"] - float(next_label_anchor.get("yRatio") or -1)) <= next_label_exclusion_dy
        )
    ]
    if col_left is not None and col_right is not None and col_right > col_left + 0.10 and (col_right - col_left) < 0.86:
        normalized_segment_bullets = []
        for item in segment_bullet_candidates:
            local = dict(item)
            local["fullXRatio"] = float(item.get("xRatio") or 0)
            local["xRatio"] = clamp((local["fullXRatio"] - col_left) / max(0.001, col_right - col_left), 0.0, 1.0)
            normalized_segment_bullets.append(local)
        segment_bullet_candidates = normalized_segment_bullets
    # SOFTM-위치맵: 선택지 불렛 전용 검색은 end-여백으로 자르지 않고 다음 문제 앵커 직전까지 포함 - 2026-06-17
    # SOFTM-위치맵: 지문/표 박스가 있는 문항은 박스 내부 글자를 선택지로 오인하지 않도록 박스 하단 이후만 탐색 - 2026-06-01
    # SOFTM-위치맵: 선택지 검색 하단은 다음 문제 시작선에서 끊어 다음 문제 본문을 이전 문항 보기로 가져오지 않도록 제한 - 2026-06-01
    # SOFTM-위치맵: 2단 PDF는 현재 문항 컬럼 내부의 원형 후보만 선택지로 사용해 반대 컬럼 본문/보기 오인식을 차단 - 2026-06-01
    # SOFTM-위치맵: 2단 PDF 선택지 배치는 페이지 전체가 아니라 현재 컬럼 내부 좌표계로 표준화해 비교 - 2026-06-01
    def candidate_quality(item):
        x = float(item.get("xRatio") or 0)
        full_x = float(item.get("fullXRatio", x) or x)
        y = float(item.get("yRatio") or 0)
        w_ratio = float(item.get("wRatio") or 0)
        h_ratio = float(item.get("hRatio") or 0)
        fill = float(item.get("fill") or 0)
        source = str(item.get("source") or "")
        score = 0.0
        if "outline" in source:
            score += 0.18
        if "ocr-token" in source:
            score += 0.05
        if 0.006 <= w_ratio <= 0.030 and 0.007 <= h_ratio <= 0.034:
            score += 0.18
        if 0.001 <= fill <= 0.090:
            score += 0.08
        if col_left is not None and col_right is not None and col_left <= full_x <= col_right:
            score += 0.12
        if next_question_start is not None and y >= next_question_start - 0.012:
            score -= 0.35
        if y < start + 0.018:
            score -= 0.20
        return score

    def normalize_layout_score(layout):
        if not layout:
            return None
        anchors = layout.get("anchors") or []
        if not anchors:
            return None
        try:
            first_y_for_title_guard = float(layout.get("firstY") or 0)
            title_guard = 0.010 if layout.get("compact") else 0.026
            if layout.get("layout") in ("horizontal", "grid") and first_y_for_title_guard > 0 and first_y_for_title_guard - choice_question_start < title_guard:
                layout["score"] = float(layout.get("score") or 0) - 1.15
                layout["titleLinePenalty"] = True
            marker_sources = [str(item.get("source", "")) for _, item in (layout.get("anchors") or [])]
            has_marker_source = any(("outline" in source or "ocr-token" in source) for source in marker_sources)
            if layout.get("layout") in ("horizontal", "grid") and not has_marker_source and first_y_for_title_guard - choice_question_start < 0.075:
                layout["score"] = float(layout.get("score") or 0) - 1.35
                layout["titleLinePenalty"] = True
        except Exception:
            pass
        # SOFTM-위치맵: 문제 제목줄 바로 옆의 ①②③④/작은 원 후보를 선택지로 오인하지 않도록 가로·그리드 후보 감점 - 2026-06-01
        ordered = sorted(anchors, key=lambda row: row[0])
        choices = [int(choice) for choice, _ in ordered]
        if choices != sorted(choices) or len(set(choices)) != len(choices):
            return None
        xs = [float(item.get("xRatio") or 0) for _, item in ordered]
        ys = [float(item.get("yRatio") or 0) for _, item in ordered]
        span_x = max(xs) - min(xs) if xs else 0
        span_y = max(ys) - min(ys) if ys else 0
        quality = sum(candidate_quality(item) for _, item in ordered)
        count = int(layout.get("foundCount") or len(anchors))
        score = float(layout.get("score") or 0) + quality + min(count, choice_count) * 0.055
        if count >= choice_count:
            score += 0.18
        if layout.get("layout") == "horizontal":
            if span_x >= 0.34 and span_y <= 0.040:
                score += 0.24
            if span_y > 0.075:
                score -= 0.22
        elif layout.get("layout") == "vertical":
            if span_y >= 0.045 and span_x <= 0.070:
                score += 0.22
            if span_x > 0.18:
                score -= 0.24
        elif layout.get("layout") == "grid":
            if span_x >= 0.22 and span_y >= 0.030:
                score += 0.16
        layout = dict(layout)
        layout["score"] = score
        return layout

    def rescue_lower_grid_from_horizontal(layout, question_start, question_end, compact=False):
        if not layout or compact or choice_count != 4 or layout.get("layout") != "horizontal":
            return None
        anchors = {int(choice): item for choice, item in (layout.get("anchors") or [])}
        if any(choice not in anchors for choice in (1, 2, 3, 4)):
            return None
        try:
            y_values = [float(anchors[choice].get("yRatio")) for choice in (1, 2, 3, 4)]
            if max(y_values) - min(y_values) > 0.018:
                return None
            x1 = float(anchors[1].get("xRatio"))
            x2 = float(anchors[2].get("xRatio"))
            x3 = float(anchors[3].get("xRatio"))
            x4 = float(anchors[4].get("xRatio"))
            if abs(x1 - 0.085) > 0.045 or abs(x3 - 0.515) > 0.055:
                return None
            if abs(x2 - 0.305) > 0.060 or abs(x4 - 0.725) > 0.065:
                return None
            w1 = float(anchors[1].get("wRatio") or 0)
            w2 = float(anchors[2].get("wRatio") or 0)
            w3 = float(anchors[3].get("wRatio") or 0)
            w4 = float(anchors[4].get("wRatio") or 0)
            reliable_w = max(0.012, min(value for value in [w1, w3] if value > 0))
            s2 = str(anchors[2].get("source", ""))
            s4 = str(anchors[4].get("source", ""))
            small_middle = ("outline" not in s2 and "ocr-token" not in s2 and w2 > 0 and w2 < reliable_w * 0.82)
            small_tail = ("outline" not in s4 and "ocr-token" not in s4 and w4 > 0 and w4 < reliable_w * 0.82)
            start = float(question_start) if question_start is not None else 0.0
            bottom_y = (float(anchors[1].get("yRatio")) + float(anchors[3].get("yRatio"))) * 0.5
            segment_height = float(question_end) - start if question_end is not None else 0.0
            short_segment_lower_row = segment_height <= 0.165 and bottom_y - start >= max(0.052, segment_height * 0.44)
            if not (small_middle and small_tail) and not short_segment_lower_row:
                return None
            min_depth = max(0.052, min(0.105, segment_height * 0.46 if question_end is not None else 0.085)) # SOFTM-문항앵커: 짧은 segment의 2행 grid도 아래행만 한 줄 가로형으로 오판하지 않게 깊이 기준을 segment 높이에 맞춤 - 2026-06-18
            if bottom_y - start < min_depth:
                return None
            gap = clamp((bottom_y - start) * 0.28, 0.026, 0.070) # SOFTM-문항앵커: 짧은 2행 선택지는 아래 행 기준 위 행 간격을 작게 추정해 정상 ①② 행을 버리지 않음 - 2026-06-18
            top_y = bottom_y - gap
            if question_end is not None and bottom_y > float(question_end) + 0.030:
                return None
            if top_y <= start + 0.024:
                return None
            top_left = dict(anchors[1])
            top_right = dict(anchors[3])
            top_left["choice"] = 1
            top_right["choice"] = 2
            top_left["yRatio"] = top_y
            top_right["yRatio"] = top_y
            top_left["source"] = f"{top_left.get('source', 'anchor-image')}-inferred-upper-grid"
            top_right["source"] = f"{top_right.get('source', 'anchor-image')}-inferred-upper-grid"
            top_left["inferred"] = True
            top_right["inferred"] = True
            bottom_left = dict(anchors[1])
            bottom_right = dict(anchors[3])
            bottom_left["choice"] = 3
            bottom_right["choice"] = 4
            return {
                "score": float(layout.get("score") or 0) + 2.0,
                "anchors": [(1, top_left), (2, top_right), (3, bottom_left), (4, bottom_right)],
                "layout": "grid",
                "foundCount": 4,
                "yDistance": abs(((top_y + bottom_y) * 0.5) - expected_grid_y),
                "gap": bottom_y - top_y,
                "firstY": top_y,
                "lastY": bottom_y,
                "compact": False,
                "rescuedLowerGrid": True,
            }
        except Exception:
            return None
    # SOFTM-위치맵: 2행 그리드의 아래 행(③④)을 한 줄 가로형(①②③④)으로 오판하면 위 행 ①②를 보간하고 아래 행 번호를 보존 - 2026-06-01

    def score_short_segment_horizontal(row_candidates, question_start, question_end, compact=False):
        if compact or choice_count != 4 or raw_band > 0.240:
            return None
        xs = [0.095, 0.310, 0.522, 0.734]
        rows = rows_from(row_candidates)
        best = None
        for row in rows:
            try:
                row_y = float(row.get("y") or 0)
                start_y = float(question_start) if question_start is not None else start
                end_y = float(question_end) if question_end is not None else high
            except Exception:
                continue
            if row_y < start_y + 0.045 or row_y > end_y + 0.020:
                continue
            if next_question_start is not None and row_y >= float(next_question_start) - 0.018:
                continue
            used = set()
            anchors = []
            dx_sum = 0.0
            for choice, expected_x in enumerate(xs, start=1):
                best_item = None
                best_idx = None
                best_dx = 999.0
                for idx, item in enumerate(row.get("items", [])):
                    if idx in used:
                        continue
                    try:
                        dx = abs(float(item.get("xRatio") or 0) - expected_x)
                        wr = float(item.get("wRatio") or 0)
                        hr = float(item.get("hRatio") or 0)
                        aspect = float(item.get("aspect", wr / max(0.0001, hr)) or 1.0)
                        fill = float(item.get("fill") or 0)
                        left_density = float(item.get("leftDensity") or 0)
                    except Exception:
                        continue
                    if dx > 0.034:
                        continue
                    if wr < 0.005 or wr > 0.026 or hr < 0.004 or hr > 0.020:
                        continue
                    if aspect < 0.42 or aspect > 1.90:
                        continue
                    if fill < 0.075 or fill > 0.42:
                        continue
                    if left_density > 0.12:
                        continue
                    if dx < best_dx:
                        best_item = item
                        best_idx = idx
                        best_dx = dx
                if best_item is None:
                    anchors = []
                    break
                used.add(best_idx)
                local = dict(best_item)
                source = str(local.get("source") or "")
                if "outline" not in source and "ocr-token" not in source and best_dx > 0.018:
                    local["xRatio"] = expected_x
                    if col_left is not None and col_right is not None and col_right > col_left:
                        local["fullXRatio"] = col_left + (expected_x * (col_right - col_left))
                    local["inferred"] = True
                    local["source"] = f'{local.get("source", "anchor-image")}-expected-x'
                # SOFTM-위치맵: 한 줄 보기에서 불렛이 약하고 텍스트 조각이 대신 잡히면 기대 x 위치로 문항앵커를 되돌림 - 2026-06-17
                local["source"] = f'{local.get("source", "anchor-image")}-short-rescue'
                anchors.append((choice, local))
                dx_sum += best_dx
            if len(anchors) < choice_count:
                continue
            y_values = [float(item.get("yRatio") or row_y) for _, item in anchors]
            x_values = [float(item.get("xRatio") or 0) for _, item in anchors]
            if max(y_values) - min(y_values) > 0.018:
                continue
            if max(x_values) - min(x_values) < 0.55:
                continue
            score = 54.0 - (dx_sum * 80) - (abs(row_y - expected_horizontal_y) * 12)
            candidate = {
                "score": score,
                "anchors": anchors,
                "layout": "horizontal",
                "foundCount": len(anchors),
                "yDistance": abs(row_y - expected_horizontal_y),
                "firstY": min(y_values),
                "lastY": max(y_values),
                "shortSegmentRescue": True,
            }
            if best is None or score > float(best.get("score", 0)):
                best = candidate
        return best
    # SOFTM-위치맵: 3번처럼 아주 짧은 전폭 문항은 새 문제를 만들지 않고 기존 문제영역 안의 완전한 ①~④ 가로행만 복구 - 2026-06-02

    def score_segment_bullet_sequence(row_candidates, question_start, question_end, compact=False):
        if choice_count < 2:
            return None
        expected_x = x_template(choice_count, "vertical", compact)[0]
        max_dx = 0.070 if compact else 0.032 # SOFTM-위치맵: 전폭 세로 보기의 왼쪽 불렛 후보는 제목 문장 글자 조각을 끌어오지 않도록 x 허용폭 축소 - 2026-06-17
        start_y = float(question_start) if question_start is not None else start
        end_y = float(question_end) if question_end is not None else high
        rows = rows_from(row_candidates)
        bullet_rows = []
        for row in rows:
            try:
                row_y = float(row.get("y") or 0)
            except Exception:
                continue
            if row_y < start_y + 0.024 or row_y > end_y + 0.016: # SOFTM-위치맵: 문제번호 바로 아래에서 시작하는 ① 보기 불렛이 하한 가드에 잘리지 않게 완화 - 2026-06-17
                continue
            best = None
            best_score = 999.0
            for item in row.get("items", []):
                try:
                    x = float(item.get("xRatio") or 0)
                    dx = abs(x - expected_x)
                    wr = float(item.get("wRatio") or 0)
                    hr = float(item.get("hRatio") or 0)
                    aspect = float(item.get("aspect", wr / max(0.0001, hr)) or 1.0)
                    fill = float(item.get("fill") or 0)
                    left_density = float(item.get("leftDensity") or 0)
                    source = str(item.get("source") or "")
                except Exception:
                    continue
                if dx > max_dx:
                    continue
                if wr < 0.006 or wr > 0.030 or hr < 0.006 or hr > 0.030:
                    continue
                if aspect < 0.55 or aspect > 1.55:
                    continue
                outline = "outline" in source or "ocr-token" in source
                if outline:
                    if fill < 0.070 or fill > 0.280:
                        continue
                    if left_density > 0.18:
                        continue
                else:
                    if fill < 0.080 or fill > 0.360:
                        continue
                    if left_density > 0.160:
                        continue
                score = dx + (0.000 if outline else 0.018) + max(0.0, left_density - 0.030) * 0.25 # SOFTM-위치맵: 첫 보기 ① 내부 획 밀도가 높아도 문제 범위 내 불렛이면 후보로 유지 - 2026-06-17
                if score < best_score:
                    best = item
                    best_score = score
            if best is not None:
                bullet_rows.append((row_y, best, best_score))
        if len(bullet_rows) < max(2, min(choice_count, 3)):
            return None
        bullet_rows = sorted(bullet_rows, key=lambda row: row[0])
        best_layout = None
        max_window = min(choice_count, len(bullet_rows))
        for start_idx in range(0, len(bullet_rows) - max_window + 1):
            window = bullet_rows[start_idx:start_idx + max_window]
            if len(window) < max_window:
                continue
            y_values = [float(row[0]) for row in window]
            gaps = [y_values[idx + 1] - y_values[idx] for idx in range(len(y_values) - 1)]
            if gaps and (min(gaps) < 0.008 or max(gaps) > 0.060):
                continue
            y_span = y_values[-1] - y_values[0]
            if y_span < 0.020 or y_span > 0.180:
                continue
            if y_values[0] < start_y + max(0.018, raw_band * 0.045): # SOFTM-위치맵: 제목 바로 아래 붙은 ① 보기 행을 보존하면서 제목줄 오인을 최소화 - 2026-06-17
                continue
            gap_mean = sum(gaps) / max(1, len(gaps)) if gaps else 0.0
            gap_variance = sum(abs(gap - gap_mean) for gap in gaps)
            outline_count = sum(1 for _, item, _ in window if "outline" in str(item.get("source", "")) or "ocr-token" in str(item.get("source", "")))
            depth = y_values[0] - start_y
            score = (len(window) * 16.0) + (outline_count * 2.5) + min(6.0, depth * 18.0) - (sum(row[2] for row in window) * 70.0) - (gap_variance * 130.0) - (start_idx * 9.0) # SOFTM-위치맵: 문제 범위 내 ① 후보를 건너뛰고 ②~④/추정행을 ①~④로 밀어 잡지 않도록 앞 window 우선 - 2026-06-17
            anchors = []
            for idx, (_, item, _) in enumerate(window, start=1):
                local = dict(item)
                local["source"] = f'{local.get("source", "anchor-image")}-segment-bullet'
                anchors.append((idx, local))
            layout = {
                "score": score,
                "anchors": anchors,
                "layout": "vertical",
                "foundCount": len(anchors),
                "yDistance": abs(((y_values[0] + y_values[-1]) * 0.5) - expected_vertical_y),
                "firstY": y_values[0],
                "lastY": y_values[-1],
                "segmentBulletSequence": True,
                "compact": compact,
            }
            if best_layout is None or score > float(best_layout.get("score", 0)):
                best_layout = layout
        return best_layout
    # SOFTM-위치맵: 문제 앵커~다음 문제 앵커 범위 안의 ①~④ 불렛 시퀀스를 문단/그림/코드 박스와 무관하게 우선 탐색 - 2026-06-17

    def score_segment_bullet_grid_sequence(row_candidates, question_start, question_end, compact=False):
        if choice_count != 4:
            return None
        xs = x_template(choice_count, "grid", compact)
        if len(xs) < 2:
            return None
        max_dx = 0.082 if compact else 0.045
        start_y = float(question_start) if question_start is not None else start
        end_y = float(question_end) if question_end is not None else high
        rows = rows_from(row_candidates)
        grid_rows = []
        for row in rows:
            try:
                row_y = float(row.get("y") or 0)
            except Exception:
                continue
            if row_y < start_y + 0.020 or row_y > end_y + 0.018:
                continue
            used = set()
            row_anchors = []
            dx_sum = 0.0
            outline_count = 0
            for expected_x in xs[:2]:
                best = None
                best_idx = None
                best_score = 999.0
                for idx, item in enumerate(row.get("items", [])):
                    if idx in used:
                        continue
                    try:
                        x = float(item.get("xRatio") or 0)
                        dx = abs(x - expected_x)
                        wr = float(item.get("wRatio") or 0)
                        hr = float(item.get("hRatio") or 0)
                        aspect = float(item.get("aspect", wr / max(0.0001, hr)) or 1.0)
                        fill = float(item.get("fill") or 0)
                        left_density = float(item.get("leftDensity") or 0)
                        source = str(item.get("source") or "")
                    except Exception:
                        continue
                    if dx > max_dx:
                        continue
                    if wr < 0.006 or wr > 0.032 or hr < 0.006 or hr > 0.032:
                        continue
                    if aspect < 0.50 or aspect > 1.65:
                        continue
                    outline = "outline" in source or "ocr-token" in source
                    if outline:
                        if fill < 0.070 or fill > 0.285:
                            continue
                        if left_density > 0.20:
                            continue
                    else:
                        if fill < 0.075 or fill > 0.420:
                            continue
                        if left_density > 0.100:
                            continue
                    score = dx + (0.000 if outline else 0.014) + max(0.0, left_density - 0.030) * 0.20
                    if score < best_score:
                        best = item
                        best_idx = idx
                        best_score = score
                if best is not None:
                    used.add(best_idx)
                    row_anchors.append((best, best_score))
                    dx_sum += best_score
                    if "outline" in str(best.get("source", "")) or "ocr-token" in str(best.get("source", "")):
                        outline_count += 1
            if len(row_anchors) >= 2:
                grid_rows.append({"y": row_y, "anchors": row_anchors, "dx": dx_sum, "outlineCount": outline_count})
        if len(grid_rows) < 2:
            return None
        best_layout = None
        for i, top_row in enumerate(grid_rows):
            for bottom_row in grid_rows[i + 1:]:
                gap = float(bottom_row["y"]) - float(top_row["y"])
                if gap < 0.030 or gap > 0.120:
                    continue
                if float(top_row["y"]) < start_y + max(0.016, raw_band * 0.045): # SOFTM-위치맵: grid 후보 생성 블록 들여쓰기를 복구해 문제 범위 내 2행 불렛 후보를 실제 평가 - 2026-06-18
                    continue
                anchors = []
                for choice, item in [(1, top_row["anchors"][0][0]), (2, top_row["anchors"][1][0]), (3, bottom_row["anchors"][0][0]), (4, bottom_row["anchors"][1][0])]:
                    local = dict(item)
                    local["source"] = f'{local.get("source", "anchor-image")}-segment-grid-bullet'
                    anchors.append((choice, local))
                dx_sum = float(top_row["dx"]) + float(bottom_row["dx"])
                outline_count = int(top_row["outlineCount"]) + int(bottom_row["outlineCount"])
                score = 68.0 + outline_count * 2.0 - dx_sum * 70.0 - abs(gap - 0.070) * 16.0 + min(5.0, (float(top_row["y"]) - start_y) * 12.0)
                layout = {
                    "score": score,
                    "anchors": anchors,
                    "layout": "grid",
                    "foundCount": 4,
                    "yDistance": abs(((float(top_row["y"]) + float(bottom_row["y"])) * 0.5) - expected_grid_y),
                    "gap": gap,
                    "firstY": float(top_row["y"]),
                    "lastY": float(bottom_row["y"]),
                    "segmentGridBulletSequence": True,
                    "compact": compact,
                }
                if best_layout is None or score > float(best_layout.get("score", 0)):
                    best_layout = layout
        return best_layout
    # SOFTM-위치맵: 문제 범위 안의 ①②/③④ 그리드 불렛도 문단/그림/코드 박스와 무관하게 우선 탐색 - 2026-06-17

    compact_column = compact_bounds
    rows = rows_from(candidates)
    segment_bullets = normalize_layout_score(score_segment_bullet_sequence(segment_bullet_candidates, choice_question_start, segment_bullet_high, compact_column))
    segment_grid_bullets = normalize_layout_score(score_segment_bullet_grid_sequence(segment_bullet_candidates, choice_question_start, segment_bullet_high, compact_column))
    strong_vertical_bullets = segment_bullets and segment_bullets.get("layout") == "vertical" and int(segment_bullets.get("foundCount") or 0) >= max(3, min(choice_count, 3)) # SOFTM-위치맵: 실제 세로형 ①~④ 시퀀스가 있으면 같은 행 본문 글자를 오른쪽 grid 불렛으로 오판하지 않음 - 2026-06-18
    if segment_grid_bullets and not strong_vertical_bullets and (not segment_bullets or float(segment_grid_bullets.get("score", 0)) >= float(segment_bullets.get("score", 0)) - 3.0):
        segment_bullets = segment_grid_bullets
    # SOFTM-위치맵: 같은 문제 범위 안에서 세로/그리드 불렛 후보를 모두 평가해 더 안정적인 배치를 선택 - 2026-06-17
    short_horizontal = normalize_layout_score(score_short_segment_horizontal(segment_bullet_candidates, choice_question_start, segment_bullet_high, compact_column))
    horizontal = normalize_layout_score(score_horizontal(rows, choice_count, expected_horizontal_y, start, compact_column))
    grid = normalize_layout_score(score_grid(rows, choice_count, expected_grid_y, start, compact_column))
    vertical = normalize_layout_score(score_vertical(rows, choice_count, expected_vertical_y, choice_question_start, high, compact_column))
    outline_vertical = normalize_layout_score(score_outline_vertical(rows, choice_count, expected_vertical_y, choice_question_start, high, compact_column))
    rescued_grid = normalize_layout_score(rescue_lower_grid_from_horizontal(horizontal, choice_question_start, high, compact_column))
    rescued_short_grid = normalize_layout_score(rescue_lower_grid_from_horizontal(short_horizontal, choice_question_start, high, compact_column))
    if rescued_short_grid and (not rescued_grid or float(rescued_short_grid.get("score", 0)) >= float(rescued_grid.get("score", 0)) - 0.75):
        rescued_grid = rescued_short_grid # SOFTM-문항앵커: short horizontal 후보도 아래 행만 잡힌 2행 grid인지 검사 - 2026-06-18
    if rescued_grid and (not grid or float(rescued_grid.get("score", 0)) >= float(grid.get("score", 0)) - 0.75):
        grid = rescued_grid
    picked = pick_layout(horizontal, grid, vertical, choice_count, bool(compact_column or (box_floor is not None and choice_count == 4) or rescued_grid))
    if rescued_grid and picked and picked.get("layout") == "horizontal" and abs(float(picked.get("firstY", 1.0)) - float(rescued_grid.get("lastY", 0.0))) <= 0.020:
        picked = rescued_grid # SOFTM-문항앵커: 2행 grid의 아래 행만 horizontal로 잡힌 경우 rescued grid를 최종 선택 - 2026-06-18
    if short_horizontal and (
        not picked
        or (picked.get("layout") == "horizontal" and not rescued_grid)
        or (not rescued_grid and float(short_horizontal.get("score", 0)) >= float(picked.get("score", 0)) - 4.0)
    ):
        picked = short_horizontal
        picked["shortSegmentFallback"] = True
    # SOFTM-위치맵: ①②③④ 한 줄 보기에서는 일반 배치 추정보다 실제 불렛 시퀀스를 우선해 텍스트로 밀린 앵커를 방지 - 2026-06-17
    grid_overrides_complete_vertical = segment_bullets and segment_bullets.get("layout") == "grid" and picked and picked.get("layout") == "vertical" and int(picked.get("foundCount") or 0) >= choice_count # SOFTM-위치맵: 완성된 세로형 선택지는 같은 줄 본문 글자 조합 grid 후보보다 우선 - 2026-06-18
    if segment_bullets and not grid_overrides_complete_vertical and (
        not picked
        or raw_band >= 0.220
        or picked.get("layout") == "vertical"
        or (
            picked.get("layout") == "horizontal"
            and segment_bullets.get("layout") == "vertical"
            and float(segment_bullets.get("firstY", 1.0)) < float(picked.get("firstY", 1.0)) - 0.030
            and int(segment_bullets.get("foundCount") or 0) >= max(3, min(choice_count, 3))
        )
    ):
        picked = segment_bullets
        picked["segmentBulletFallback"] = True
    # SOFTM-위치맵: 긴 문제영역에서는 배치 추정보다 실제 ①~④ 불렛 시퀀스를 우선해 코드/이미지 뒤 보기 누락을 줄임 - 2026-06-17
    if picked and outline_vertical and picked.get("layout") in ("grid", "horizontal"):
        picked_anchors = picked.get("anchors") or []
        right_non_outline = any(
            choice in (2, 4)
            and "outline" not in str(item.get("source", ""))
            for choice, item in picked_anchors
        )
        if right_non_outline and float(outline_vertical.get("firstY", 1.0)) <= float(picked.get("firstY", 1.0)) + 0.018 and float(outline_vertical.get("lastY", 0.0)) >= float(picked.get("lastY", 0.0)) - 0.014:
            picked = outline_vertical
    if not picked:
        short_horizontal = normalize_layout_score(score_short_segment_horizontal(candidates, choice_question_start, high, compact_column))
        if short_horizontal:
            short_horizontal["titleLinePenalty"] = False
            picked = short_horizontal
            picked["shortSegmentFallback"] = True
    if not picked:
        if box_floor is not None and box_floor_low is not None:
            fallback_low = max(choice_question_start + 0.040, float(box_floor) - 0.010)
            fallback_high = min(high, float(box_floor_low) + 0.030)
            if fallback_high > fallback_low + 0.010:
                fallback_candidates = [
                    item for item in page_candidates
                    if fallback_low <= item["yRatio"] <= fallback_high
                    and (col_left is None or (item["xRatio"] >= col_left and item["xRatio"] <= col_right))
                    and not (
                        label_anchor
                        and int(label_anchor.get("page") or 0) == page
                        and abs(item["xRatio"] - float(label_anchor.get("xRatio") or -1)) <= label_exclusion_dx
                        and abs(item["yRatio"] - float(label_anchor.get("yRatio") or -1)) <= current_label_exclusion_dy
                    )
                ]
                if col_left is not None and col_right is not None and col_right > col_left + 0.10 and (col_right - col_left) < 0.86:
                    normalized_fallback = []
                    for item in fallback_candidates:
                        local = dict(item)
                        local["fullXRatio"] = float(item.get("xRatio") or 0)
                        local["xRatio"] = clamp((local["fullXRatio"] - col_left) / max(0.001, col_right - col_left), 0.0, 1.0)
                        normalized_fallback.append(local)
                    fallback_candidates = normalized_fallback
                fallback_rows = rows_from(fallback_candidates)
                fallback_expected = clamp((fallback_low + fallback_high) * 0.5, fallback_low, fallback_high)
                fallback_horizontal = normalize_layout_score(score_horizontal(fallback_rows, choice_count, fallback_expected, choice_question_start, compact_column))
                fallback_grid = normalize_layout_score(score_grid(fallback_rows, choice_count, fallback_expected, choice_question_start, compact_column))
                picked = pick_layout(fallback_horizontal, fallback_grid, None, choice_count, False)
                if picked:
                    picked["boxFloorFallback"] = True
        if not picked:
            continue
    anchors = []
    anchor_confidence = 0.88 if picked.get("layout") == "grid" else (0.84 if picked.get("layout") == "vertical" else 0.76)
    if int(picked.get("foundCount") or len(picked["anchors"])) >= choice_count:
        anchor_confidence = min(0.94, anchor_confidence + 0.06)
    for choice, item in sorted(picked["anchors"], key=lambda row: row[0]):
        anchors.append({
            "choice": choice,
            "page": page,
            "xRatio": item.get("fullXRatio", item["xRatio"]),
            "yRatio": item["yRatio"],
            "wRatio": max(0.01, item["wRatio"]),
            "hRatio": max(0.012, item["hRatio"]),
            "source": item.get("source", "anchor-image"),
            "anchorMode": "center", # SOFTM-위치맵: 이미지 선택지 앵커가 중심좌표임을 명시 - 2026-05-30
            "layout": picked.get("layout"),
            "confidence": min(anchor_confidence, 0.62) if item.get("inferred") else anchor_confidence
        })
    result[str(q)] = anchors

print(json.dumps(result, ensure_ascii=False))
`;
  const result = await run("python3", ["-c", script, pageDir, mapPath], { maxBuffer: 40 * 1024 * 1024 });
  return JSON.parse(result.stdout || "{}");
}

function isReliableChoiceAnchor(item, choiceCount){
  if (!item || typeof item !== "object") return false;
  const source = String(item.source || "").toLowerCase();
  if (source.includes("geometry") || source.includes("fill")) return false;
  const choice = Number(item.choice);
  const page = Number(item.page);
  const x = Number(item.xRatio);
  const y = Number(item.yRatio);
  const w = Number(item.wRatio);
  const h = Number(item.hRatio);
  const confidence = item.confidence == null ? 1 : Number(item.confidence);
  if (source.includes("ocr-token") && ((Number.isFinite(w) && w > 0.040) || (Number.isFinite(h) && h > 0.035))) return false; // SOFTM-위치맵: 넓은 OCR 숫자 토큰은 본문 조각 오탐으로 보고 선택지 앵커에서 제외 - 2026-06-16
  return Number.isInteger(choice)
    && choice >= 1
    && choice <= choiceCount
    && Number.isFinite(page)
    && page >= 1
    && Number.isFinite(x)
    && x >= 0
    && x <= 1
    && Number.isFinite(y)
    && y >= 0
    && y <= 1
	    && (!Number.isFinite(confidence) || confidence >= 0.45);
}

function isSuspiciousVerticalChoiceAnchorSet(anchors, questionSegments, q, choiceCount){
  const expected = Math.max(3, Math.min(5, Number(choiceCount) || 4));
  const list = (Array.isArray(anchors) ? anchors : [])
    .filter((item) => Number.isInteger(Number(item?.choice)) && Number(item.choice) >= 1 && Number(item.choice) <= expected)
    .sort((a, b) => Number(a.choice) - Number(b.choice));
  if (list.length < Math.min(expected, 4)) return false;
  const page = Number(list[0]?.page);
  if (!Number.isFinite(page) || list.some((item) => Number(item?.page) !== page)) return false;
  const xs = list.map((item) => Number(item.xRatio)).filter(Number.isFinite);
  const ys = list.map((item) => Number(item.yRatio)).filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length !== list.length || ys.length !== list.length) return false;
  const xSpread = Math.max(...xs) - Math.min(...xs);
  if (xSpread > 0.060) return false;
  const gaps = [];
  for (let idx = 0; idx < ys.length - 1; idx += 1){
    const gap = ys[idx + 1] - ys[idx];
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (gaps.length < 2) return false;
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  if (!(minGap < 0.026 && maxGap > Math.max(0.070, minGap * 3.8))) return false;
  const segment = (questionSegments?.[String(q)] || []).find((item) => Number(item?.page) === page);
  if (!segment) return true;
  const top = Number(segment.top);
  const bottom = Number(segment.bottom);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return true;
  const height = bottom - top;
  if (height < 0.18) return false;
  return ys[1] < top + Math.max(0.075, height * 0.24);
}
// SOFTM-문항영역: 코드/이미지 내부 숫자가 세로형 보기 앵커처럼 잡힌 경우 영역 생성에서 제외 - 2026-06-17

function normalizeReliableChoiceMap(imageMap, questionCount, choiceCount, questionSegments = {}){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = imageMap && Array.isArray(imageMap[String(q)]) ? imageMap[String(q)] : [];
    const byChoice = new Map();
    for (const item of anchors){
      if (!isReliableChoiceAnchor(item, choiceCount)) continue;
      const choice = Number(item.choice);
      const previous = byChoice.get(choice);
      if (!previous || Number(item.confidence || 0) >= Number(previous.confidence || 0)) {
        byChoice.set(choice, item);
      }
    }
    if (byChoice.size) {
      const list = Array.from(byChoice.values()).sort((a, b) => Number(a.choice) - Number(b.choice));
      if (!isSuspiciousVerticalChoiceAnchorSet(list, questionSegments, q, choiceCount)) out[String(q)] = list;
    }
  }
  return out;
}

function clampGeneratedRatio(value, min = 0, max = 1){
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

/* SOFTM-문항영역 시작: OCR이 약한 PDF도 위치맵 생성 시 선택지 앵커에서 기본 문항영역을 함께 저장 - 2026-06-16 */
function repairGridChoiceMap(choiceMap, questionSegments, questionCount, choiceCount){
  const out = {};
  const segmentFor = (q, page, point = null) => {
    const segments = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : [];
    const samePage = segments.filter((segment) => Number(segment.page) === Number(page));
    const x = Number(point?.xRatio);
    const y = Number(point?.yRatio);
    return samePage.find((segment) => {
      const left = Number.isFinite(Number(segment?.left)) ? Number(segment.left) : 0;
      const right = Number.isFinite(Number(segment?.right)) ? Number(segment.right) : 1;
      const top = Number.isFinite(Number(segment?.top)) ? Number(segment.top) : 0;
      const bottom = Number.isFinite(Number(segment?.bottom)) ? Number(segment.bottom) : 1;
      return (!Number.isFinite(x) || (x >= left - 0.030 && x <= right + 0.030))
        && (!Number.isFinite(y) || (y >= top - 0.030 && y <= bottom + 0.050));
    }) || samePage[0] || null;
  };
  const inferMissingGridAnchor = (q, byChoice, missingChoice) => {
    if (choiceCount !== 4) return null;
    const c1 = byChoice.get(1);
    const c2 = byChoice.get(2);
    const c3 = byChoice.get(3);
    const c4 = byChoice.get(4);
    const page = Number((c1 || c2 || c3 || c4)?.page);
    if (!Number.isFinite(page)) return null;
    let x = null;
    let y = null;
    if (missingChoice === 1 && c2 && c3 && c4) {
      x = Number(c3.xRatio);
      y = Number(c2.yRatio);
    } else if (missingChoice === 2 && c1 && c3 && c4) {
      x = Number(c4.xRatio);
      y = Number(c1.yRatio);
    } else if (missingChoice === 3 && c1 && c2 && c4) {
      x = Number(c1.xRatio);
      y = Number(c4.yRatio);
    } else if (missingChoice === 4 && c1 && c2 && c3) {
      x = Number(c2.xRatio);
      y = Number(c3.yRatio);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const leftX = Number.isFinite(Number(c1?.xRatio)) && Number.isFinite(Number(c3?.xRatio))
      ? (Number(c1.xRatio) + Number(c3.xRatio)) * 0.5
      : (Number.isFinite(Number(c1?.xRatio)) ? Number(c1.xRatio) : Number(c3?.xRatio));
    const rightX = Number.isFinite(Number(c2?.xRatio)) && Number.isFinite(Number(c4?.xRatio))
      ? (Number(c2.xRatio) + Number(c4.xRatio)) * 0.5
      : (Number.isFinite(Number(c2?.xRatio)) ? Number(c2.xRatio) : Number(c4?.xRatio));
    const topY = Number.isFinite(Number(c1?.yRatio)) && Number.isFinite(Number(c2?.yRatio))
      ? (Number(c1.yRatio) + Number(c2.yRatio)) * 0.5
      : (Number.isFinite(Number(c1?.yRatio)) ? Number(c1.yRatio) : Number(c2?.yRatio));
    const bottomY = Number.isFinite(Number(c3?.yRatio)) && Number.isFinite(Number(c4?.yRatio))
      ? (Number(c3.yRatio) + Number(c4.yRatio)) * 0.5
      : (Number.isFinite(Number(c3?.yRatio)) ? Number(c3.yRatio) : Number(c4?.yRatio));
    if (!Number.isFinite(leftX) || !Number.isFinite(rightX) || !Number.isFinite(topY) || !Number.isFinite(bottomY)) return null;
    const dx = rightX - leftX;
    const dy = bottomY - topY;
    if (dx < 0.080 || dx > 0.560 || dy < 0.006 || dy > 0.095) return null;
    const segment = segmentFor(q, page, { xRatio: x, yRatio: y });
    const segLeft = clampGeneratedRatio(segment?.left ?? 0, 0, 1);
    const segRight = clampGeneratedRatio(segment?.right ?? 1, 0, 1);
    const segTop = clampGeneratedRatio(segment?.top ?? 0, 0, 1);
    const segBottom = clampGeneratedRatio(segment?.bottom ?? 1, 0, 1);
    if (x < segLeft - 0.035 || x > segRight + 0.035 || y < segTop - 0.025 || y > segBottom + 0.045) return null;
    const base = byChoice.get(missingChoice === 1 ? 3 : (missingChoice === 2 ? 4 : (missingChoice === 3 ? 1 : 2))) || c1 || c2 || c3 || c4;
    return {
      ...base,
      choice: missingChoice,
      page,
      xRatio: clampGeneratedRatio(x),
      yRatio: clampGeneratedRatio(y),
      wRatio: Math.max(0.010, Math.min(0.020, Number(base?.wRatio) || 0.012)),
      hRatio: Math.max(0.010, Math.min(0.020, Number(base?.hRatio) || 0.012)),
      source: `${base?.source || "anchor-image"}-post-inferred-grid`,
      anchorMode: "center",
      layout: "grid",
      inferred: true,
      confidence: Math.min(0.62, Number(base?.confidence) || 0.62),
    };
  };
  const inferMissingHorizontalAnchor = (q, byChoice, missingChoice) => {
    if (choiceCount !== 4) return null;
    const present = [...byChoice.values()].filter(Boolean);
    if (present.length < 3) return null;
    const page = Number(present[0]?.page);
    if (!Number.isFinite(page) || present.some((item) => Number(item?.page) !== page)) return null;
    const ys = present.map((item) => Number(item.yRatio)).filter(Number.isFinite);
    const xs = present.map((item) => Number(item.xRatio)).filter(Number.isFinite);
    if (ys.length !== present.length || xs.length !== present.length) return null;
    const ySpread = Math.max(...ys) - Math.min(...ys);
    const xSpread = Math.max(...xs) - Math.min(...xs);
    if (ySpread > 0.018 || xSpread < 0.38) return null;
    const expectedX = [0, 0.095, 0.310, 0.522, 0.734][missingChoice];
    const y = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const segment = segmentFor(q, page, { xRatio: expectedX, yRatio: y });
    const segLeft = clampGeneratedRatio(segment?.left ?? 0, 0, 1);
    const segRight = clampGeneratedRatio(segment?.right ?? 1, 0, 1);
    const segTop = clampGeneratedRatio(segment?.top ?? 0, 0, 1);
    const segBottom = clampGeneratedRatio(segment?.bottom ?? 1, 0, 1);
    if (expectedX < segLeft - 0.020 || expectedX > segRight + 0.020 || y < segTop - 0.020 || y > segBottom + 0.050) return null;
    const base = present.reduce((best, item) => {
      if (!best) return item;
      return Math.abs(Number(item.choice) - missingChoice) < Math.abs(Number(best.choice) - missingChoice) ? item : best;
    }, null);
    return {
      ...base,
      choice: missingChoice,
      page,
      xRatio: clampGeneratedRatio(expectedX),
      yRatio: clampGeneratedRatio(y),
      wRatio: Math.max(0.010, Math.min(0.020, Number(base?.wRatio) || 0.012)),
      hRatio: Math.max(0.010, Math.min(0.020, Number(base?.hRatio) || 0.012)),
      source: `${base?.source || "anchor-image"}-post-inferred-horizontal`,
      anchorMode: "center",
      layout: "horizontal",
      inferred: true,
      confidence: Math.min(0.62, Number(base?.confidence) || 0.62),
    };
  };
  // SOFTM-문항앵커: 한 줄 보기에서 한 개 원형만 누락되면 형제 앵커 행과 기대 x 위치로 보수 생성 - 2026-06-17
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].filter((item) => isReliableChoiceAnchor(item, choiceCount)) : [];
    if (!anchors.length) continue;
    const byChoice = new Map();
    for (const item of anchors) byChoice.set(Number(item.choice), { ...item });
    const missing = [];
    for (let choice = 1; choice <= choiceCount; choice += 1){
      if (!byChoice.has(choice)) missing.push(choice);
    }
    if (missing.length === 1) {
      const inferred = inferMissingGridAnchor(q, byChoice, missing[0]) || inferMissingHorizontalAnchor(q, byChoice, missing[0]);
      if (inferred) byChoice.set(missing[0], inferred);
    }
    out[String(q)] = [...byChoice.values()].sort((a, b) => Number(a.choice) - Number(b.choice));
  }
  return out;
}

function buildSegmentChoiceAnchorFallbackMap(choiceMap, questionSegments, questionColumnBoundsMap, pageMap, questionCount, choiceCount, questionLabelMap = {}){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const existing = Array.isArray(choiceMap?.[String(q)])
      ? choiceMap[String(q)].filter((item) => isReliableChoiceAnchor(item, choiceCount))
      : [];
    const hasCompleteExisting = existing.length >= choiceCount;
    const hasPartialExisting = existing.length > 0 && existing.length < choiceCount;
    const segments = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : [];
    const primary = segments.find((segment) => segment && segment.continuation !== true) || segments[0] || null;
    const continuation = segments.find((segment) => segment && segment.continuation === true) || null;
    const primaryHeight = primary ? Number(primary.bottom) - Number(primary.top) : 0;
    const shouldUseContinuationFallback = primary
      && continuation
      && Number(primary.bottom) >= 0.780
      && Number.isFinite(primaryHeight)
      && (primaryHeight < 0.115 || Number(primary.top) >= 0.780); // SOFTM-문항앵커: 단 하단에서 시작한 연속 문항은 보기 생성 기준을 다음 단 continuation으로 둠 - 2026-06-18
    const fallbackSegment = shouldUseContinuationFallback ? continuation : primary;
    if (!fallbackSegment) {
      if (existing.length) out[String(q)] = existing;
      continue;
    }
    const page = Number(fallbackSegment.page || pageMap[q]);
    const left = clampGeneratedRatio(fallbackSegment.left ?? questionColumnBoundsMap?.[String(q)]?.left ?? 0, 0, 1);
    const right = clampGeneratedRatio(fallbackSegment.right ?? questionColumnBoundsMap?.[String(q)]?.right ?? 1, 0, 1);
    const top = clampGeneratedRatio(fallbackSegment.top, 0, 1);
    const bottom = clampGeneratedRatio(fallbackSegment.bottom, 0, 1);
    const width = right - left;
    const height = bottom - top;
    if (!Number.isFinite(page) || page < 1 || width < 0.30) {
      if (existing.length) out[String(q)] = existing;
      continue;
    }
    const existingXValues = existing.map((item) => Number(item.xRatio)).filter(Number.isFinite);
    const existingXSpread = existingXValues.length
      ? Math.max(...existingXValues) - Math.min(...existingXValues)
      : 0;
    const isVerticalSegmentFallback = hasCompleteExisting
      && existingXSpread < 0.080
      && existing.every((item) => String(item?.source || "").startsWith("segment-choice-anchor") && item?.layout === "vertical");
    const isCollapsedGridCandidate = existing.length >= Math.min(3, choiceCount)
      && choiceCount === 4
      && width >= 0.30
      && height >= 0.070
      && height <= 0.130
      && existingXSpread < Math.max(0.070, width * 0.20)
      && (height <= 0.105 || existing.some((item) => String(item?.source || "").includes("post-inferred-trailing"))); // SOFTM-문항앵커: 2x2 보기 앵커가 한 열로 몰린 경우 partial/complete 모두 grid fallback으로 교체 - 2026-06-17
    const existingYValues = existing.map((item) => Number(item.yRatio)).filter(Number.isFinite);
    const buildTopCompactVerticalLeadingRepair = () => {
      if (choiceCount !== 4 || existing.length !== 4 || width >= 0.70 || height > 0.180) return null;
      const byChoice = new Map(existing.map((item) => [Number(item.choice), item]));
      const ordered = [1, 2, 3, 4].map((choice) => byChoice.get(choice));
      if (ordered.some((item) => !item)) return null;
      const xs = ordered.map((item) => Number(item.xRatio)).filter(Number.isFinite);
      const ys = ordered.map((item) => Number(item.yRatio)).filter(Number.isFinite).sort((a, b) => a - b);
      if (xs.length !== 4 || ys.length !== 4) return null;
      const xSpread = Math.max(...xs) - Math.min(...xs);
      if (xSpread > Math.max(0.050, width * 0.14)) return null;
      const sources = ordered.map((item) => String(item.source || "").toLowerCase());
      if (!sources.every((source) => source.includes("segment-bullet"))) return null;
      const labelY = Number(questionLabelMap?.[String(q)]?.yRatio);
      if (!Number.isFinite(labelY) || labelY < top - 0.006 || labelY > bottom) return null;
      const gaps = ys.slice(1).map((value, idx) => value - ys[idx]);
      const sortedGaps = gaps.slice().sort((a, b) => a - b);
      const gap = sortedGaps[Math.floor(sortedGaps.length / 2)];
      if (!Number.isFinite(gap) || gap < 0.010 || gap > 0.026) return null;
      if (Math.max(...gaps) - Math.min(...gaps) > 0.010) return null;
      if (ys[0] - labelY < Math.max(0.050, height * 0.36)) return null;
      const leadingY = clampGeneratedRatio(
        labelY + Math.max(0.022, Math.min(0.034, gap * 1.75)),
        top + 0.030,
        ys[0] - Math.max(0.006, gap * 0.45),
      );
      const leading = {
        ...ordered[0],
        choice: 1,
        yRatio: leadingY,
        source: `${ordered[0].source || "anchor-image"}-post-inferred-leading-compact`,
        inferred: true,
        confidence: Math.min(0.62, Number(ordered[0].confidence || 0.62)),
      };
      const repaired = [leading];
      for (let idx = 0; idx < 3; idx += 1){
        repaired.push({
          ...ordered[idx],
          choice: idx + 2,
          source: `${ordered[idx].source || "anchor-image"}-post-shifted-leading-compact`,
        });
      }
      return repaired.sort((a, b) => Number(a.choice) - Number(b.choice));
    };
    const compactVerticalLeadingRepair = buildTopCompactVerticalLeadingRepair();
    if (compactVerticalLeadingRepair) {
      out[String(q)] = compactVerticalLeadingRepair;
      continue;
    }
    // SOFTM-문항앵커: 짧은 2단 세로형에서 첫 보기 원형이 누락되어 ②~④가 ①~③으로 밀린 경우에만 선두 보기 복원 - 2026-06-19
    const buildHorizontalFromLowerShortRescueGrid = () => {
      if (choiceCount !== 4 || width < 0.70 || existing.length < 4) return null;
      const byChoice = new Map(existing.map((item) => [Number(item.choice), item]));
      const upper = [byChoice.get(1), byChoice.get(2)];
      const lower = [byChoice.get(3), byChoice.get(4)];
      if (upper.some((item) => !item) || lower.some((item) => !item)) return null;
      const upperSources = upper.map((item) => String(item.source || "").toLowerCase());
      const lowerSources = lower.map((item) => String(item.source || "").toLowerCase());
      if (!upperSources.every((source) => source.includes("short-rescue") && source.includes("inferred-upper-grid"))) return null;
      if (!lowerSources.every((source) => source.includes("short-rescue"))) return null;
      const upperY = upper.map((item) => Number(item.yRatio)).filter(Number.isFinite);
      const lowerY = lower.map((item) => Number(item.yRatio)).filter(Number.isFinite);
      if (upperY.length !== 2 || lowerY.length !== 2) return null;
      const y = lowerY.reduce((sum, value) => sum + value, 0) / lowerY.length;
      const upperMean = upperY.reduce((sum, value) => sum + value, 0) / upperY.length;
      if (y - upperMean < Math.max(0.018, height * 0.18)) return null;
      if (y < top + height * 0.52 || y > bottom - 0.006) return null;
      const base = lower.reduce((best, item) => Number(item.confidence || 0) > Number(best?.confidence || 0) ? item : best, lower[0]);
      const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + width * ratio, left + width * 0.040, right - width * 0.040));
      return xs.map((xRatio, index) => ({
        ...base,
        choice: index + 1,
        page,
        xRatio,
        yRatio: clampGeneratedRatio(y, top + 0.020, bottom - 0.006),
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.014)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-horizontal",
        anchorMode: "center",
        layout: "horizontal",
        confidence: Math.min(0.62, Number(base?.confidence) || 0.62),
        inferred: true,
      }));
    };
    const buildCollapsedColumnGridReplacement = () => {
      if (choiceCount !== 4 || width >= 0.70 || height < 0.145 || existing.length < 4) return null;
      const byChoice = new Map(existing.map((item) => [Number(item.choice), item]));
      const choices = [1, 2, 3, 4].map((choice) => byChoice.get(choice));
      if (choices.some((item) => !item)) return null;
      const xs = choices.map((item) => Number(item.xRatio)).filter(Number.isFinite);
      const ys = choices.map((item) => Number(item.yRatio)).filter(Number.isFinite).sort((a, b) => a - b);
      if (xs.length !== 4 || ys.length !== 4) return null;
      const xSpread = Math.max(...xs) - Math.min(...xs);
      if (xSpread > Math.max(0.045, width * 0.18)) return null;
      const sources = choices.map((item) => String(item.source || "").toLowerCase());
      if (!sources.some((source) => source.includes("anchor-image"))) return null;
      const yGaps = ys.slice(1).map((value, idx) => value - ys[idx]);
      const ySpan = ys[ys.length - 1] - ys[0];
      const segmentBulletVertical = sources.every((source) => source.includes("segment-bullet"))
        && ySpan >= 0.038
        && yGaps.every((gap) => gap >= 0.009 && gap <= 0.026)
        && Math.max(...yGaps) - Math.min(...yGaps) <= 0.010;
      if (segmentBulletVertical) return null; // SOFTM-문항앵커: 실제 세로형 선택지 원형 4개가 이미 잡힌 경우 tail/grid fallback으로 덮지 않음 - 2026-06-19
      const xLeft = clampGeneratedRatio(Math.min(...xs), left + width * 0.055, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.525, left + width * 0.36, right - width * 0.080);
      let yTop = NaN;
      let yBottom = NaN;
      let source = "segment-choice-anchor-text-grid-collapsed-column";
      if (ys[1] - ys[0] >= 0.008 && ys[1] - ys[0] <= 0.034 && ys[3] < top + height * 0.72) {
        yTop = ys[0];
        yBottom = ys[1];
      } else if (ys[3] >= top + height * 0.66) {
        yTop = ys[3];
        yBottom = Math.min(bottom - 0.006, yTop + Math.max(0.014, Math.min(0.026, height * 0.075)));
        source = "segment-choice-anchor-tail-grid-collapsed-column";
      } else {
        return null;
      }
      if (!Number.isFinite(yTop) || !Number.isFinite(yBottom) || yBottom <= yTop) return null;
      const base = choices.reduce((best, item) => Number(item.confidence || 0) > Number(best?.confidence || 0) ? item : best, choices[0]);
      return [
        { choice: 1, xRatio: xLeft, yRatio: yTop },
        { choice: 2, xRatio: xRight, yRatio: yTop },
        { choice: 3, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...base,
        ...item,
        page,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.024)),
        hRatio: 0.012,
        source,
        anchorMode: "center",
        layout: "grid",
        confidence: 0.56,
        inferred: true,
      }));
    };
    const shortRescueHorizontal = buildHorizontalFromLowerShortRescueGrid();
    if (shortRescueHorizontal) {
      out[String(q)] = shortRescueHorizontal;
      continue;
    }
    const collapsedColumnGrid = buildCollapsedColumnGridReplacement();
    if (collapsedColumnGrid) {
      out[String(q)] = collapsedColumnGrid;
      continue;
    }
    // SOFTM-문항앵커: 본문/코드 원형을 보기로 오인한 완성 앵커도 문제 segment 안의 실제 보기 행 기준으로 재배치 - 2026-06-18
    const singleLowerHorizontalSignal = choiceCount === 4
      && existing.length === 1
      && width >= 0.70
      && height >= 0.110
      && height <= 0.150
      && existingYValues.length === 1
      && existingYValues[0] >= top + height * 0.55
      && existingYValues[0] <= bottom - 0.010; // SOFTM-문항앵커: 전폭 짧은 문항에서 보기 후보 하나가 하단 행에만 잡히면 2행 grid 대신 한 줄 보기로 판단 - 2026-06-18
    if (singleLowerHorizontalSignal) {
      const y = clampGeneratedRatio(existingYValues[0], top + height * 0.46, bottom - 0.006);
      const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + width * ratio, left + width * 0.040, right - width * 0.040));
      out[String(q)] = xs.map((xRatio, index) => ({
        choice: index + 1,
        page,
        xRatio,
        yRatio: y,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.014)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-horizontal",
        anchorMode: "center",
        layout: "horizontal",
        confidence: 0.55,
        inferred: true,
      }));
      continue;
    }
    if (isCollapsedGridCandidate) {
      const xLeft = clampGeneratedRatio(left + width * 0.095, left + width * 0.055, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.522, left + width * 0.36, right - width * 0.10);
      const yTop = clampGeneratedRatio(top + height * 0.430, top + height * 0.34, bottom - height * 0.34); // SOFTM-문항앵커: 전폭 2행 grid fallback 첫 행이 아래 행으로 밀리지 않도록 segment 중간보다 위에서 시작 - 2026-06-17
      const yBottom = clampGeneratedRatio(top + height * 0.780, yTop + Math.max(0.018, height * 0.16), bottom - 0.006); // SOFTM-문항앵커: 전폭 2행 grid fallback 아래 행은 실제 두 번째 행 근처로 유지 - 2026-06-17
      const labelY = Number(questionLabelMap?.[String(q)]?.yRatio);
      const gridTopHitsQuestionLine = width >= 0.70
        && height >= 0.110
        && Number.isFinite(labelY)
        && Math.abs(yTop - labelY) <= Math.max(0.010, height * 0.13); // SOFTM-문항앵커: grid 첫 행이 문제번호/문제문 줄이면 실제 보기는 아래 한 줄로 판단 - 2026-06-18
      if (gridTopHitsQuestionLine) {
        const y = clampGeneratedRatio(top + height * 0.700, top + height * 0.55, bottom - 0.006);
        const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + width * ratio, left + width * 0.040, right - width * 0.040));
        out[String(q)] = xs.map((xRatio, index) => ({
          choice: index + 1,
          page,
          xRatio,
          yRatio: y,
          wRatio: Math.max(0.010, Math.min(0.020, width * 0.014)),
          hRatio: 0.012,
          source: "segment-choice-anchor-text-horizontal",
          anchorMode: "center",
          layout: "horizontal",
          confidence: 0.55,
          inferred: true,
        }));
        continue;
      }
      out[String(q)] = [
        { choice: 1, page, xRatio: xLeft, yRatio: yTop },
        { choice: 2, page, xRatio: xRight, yRatio: yTop },
        { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, page, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...item,
        wRatio: Math.max(0.010, Math.min(0.022, width * 0.018)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-grid",
        anchorMode: "center",
        layout: "grid",
        confidence: 0.55,
        inferred: true,
      }));
      continue;
    }
    if (width >= 0.70 && height >= 0.140 && bottom >= 0.900 && choiceCount === 4 && (!existing.length || isVerticalSegmentFallback)) { // SOFTM-문항앵커: q33처럼 하단 segment가 짧아도 한 줄 보기 page-tail은 가로형으로 유지 - 2026-06-18
      // SOFTM-문항앵커: 문제~다음 문제 segment가 길어도 하단에 ①②③④ 한 줄 보기만 있는 전폭 page-tail은 세로 추정 대신 가로행으로 보수 생성 - 2026-06-17
      const yOffset = Math.min(0.048, Math.max(0.038, height * 0.085)); // SOFTM-문항앵커: 긴 page-tail 한 줄 보기는 segment 하단 비율이 아니라 문제 직후 보기 원형 행에 맞춤 - 2026-06-18
      const y = clampGeneratedRatio(top + yOffset, top + 0.034, bottom - 0.020);
      const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + width * ratio, left + width * 0.040, right - width * 0.040));
      out[String(q)] = xs.map((xRatio, index) => ({
        choice: index + 1,
        page,
        xRatio,
        yRatio: y,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.014)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-horizontal",
        anchorMode: "center",
        layout: "horizontal",
        confidence: 0.54,
        inferred: true,
      }));
      continue;
    }
    if (hasCompleteExisting) {
      out[String(q)] = existing;
      continue;
    }
    if (hasPartialExisting) {
      out[String(q)] = existing;
      continue;
    }
    if (width < 0.70 && height >= 0.055 && height <= 0.110 && choiceCount === 4) {
      // SOFTM-문항앵커: 2단 짧은 2행 보기에서 이미지 불렛이 모두 누락되면 문제~다음 문제 segment 안의 grid 위치로 보수 생성 - 2026-06-17
      const xLeft = clampGeneratedRatio(left + width * 0.112, left + width * 0.050, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.525, left + width * 0.36, right - width * 0.080);
      const yTop = clampGeneratedRatio(top + height * 0.640, top + height * 0.42, bottom - height * 0.22);
      const yBottom = clampGeneratedRatio(top + height * 0.825, yTop + Math.max(0.014, height * 0.14), bottom - 0.004);
      out[String(q)] = [
        { choice: 1, page, xRatio: xLeft, yRatio: yTop },
        { choice: 2, page, xRatio: xRight, yRatio: yTop },
        { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, page, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...item,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.024)),
        hRatio: 0.012,
        source: "segment-choice-anchor",
        anchorMode: "center",
        layout: "grid",
        confidence: 0.55,
        inferred: true,
      }));
      continue;
    }
    if (width >= 0.70 && height >= 0.070 && height <= 0.104 && choiceCount === 4) {
      // SOFTM-문항앵커: 촘촘한 전폭 초단문 한 줄 보기는 이미지 원형이 전부 약하면 segment 하단의 ①②③④ 가로행으로 보수 생성 - 2026-06-17
      const y = clampGeneratedRatio(top + height * 0.550, top + height * 0.42, bottom - 0.006); // SOFTM-문항앵커: 전폭 초단문 한 줄 fallback이 실제 ①②③④ 행보다 아래로 밀리지 않게 보정 - 2026-06-18
      const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + width * ratio, left + width * 0.040, right - width * 0.040));
      out[String(q)] = xs.map((xRatio, index) => ({
        choice: index + 1,
        page,
        xRatio,
        yRatio: y,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.014)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-horizontal",
        anchorMode: "center",
        layout: "horizontal",
        confidence: 0.54,
        inferred: true,
      }));
      continue;
    }
    if (width >= 0.70 && height > 0.104 && height < 0.110 && choiceCount === 4) {
      // SOFTM-문항앵커: 전폭 짧은 2행 보기는 기존 0.110 하한보다 살짝 낮아도 ①②/③④ grid로 보수 생성 - 2026-06-17
      const xLeft = clampGeneratedRatio(left + width * 0.095, left + width * 0.055, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.522, left + width * 0.36, right - width * 0.10);
      const yTop = clampGeneratedRatio(top + height * 0.430, top + height * 0.34, bottom - height * 0.34); // SOFTM-문항앵커: 전폭 짧은 grid fallback의 첫 행 위치를 실제 ①② 행 쪽으로 보정 - 2026-06-17
      const yBottom = clampGeneratedRatio(top + height * 0.780, yTop + Math.max(0.018, height * 0.16), bottom - 0.006);
      out[String(q)] = [
        { choice: 1, page, xRatio: xLeft, yRatio: yTop },
        { choice: 2, page, xRatio: xRight, yRatio: yTop },
        { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, page, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...item,
        wRatio: Math.max(0.010, Math.min(0.022, width * 0.018)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-grid",
        anchorMode: "center",
        layout: "grid",
        confidence: 0.54,
        inferred: true,
      }));
      continue;
    }
    if (width < 0.70 && height >= 0.145 && height <= 0.245 && choiceCount === 4) {
      // SOFTM-문항앵커: 2단 중간의 이미지 2x2 보기는 이미지 불렛 후보가 비어도 문제 segment 안에서 grid 기준점을 보수 생성 - 2026-06-17
      const xLeft = clampGeneratedRatio(left + width * 0.152, left + width * 0.045, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.535, left + width * 0.36, right - width * 0.080);
      const yTop = clampGeneratedRatio(top + height * 0.105, top + height * 0.06, bottom - height * 0.44);
      const yBottom = clampGeneratedRatio(top + height * 0.545, yTop + Math.max(0.050, height * 0.28), bottom - 0.010);
      out[String(q)] = [
        { choice: 1, page, xRatio: xLeft, yRatio: yTop },
        { choice: 2, page, xRatio: xRight, yRatio: yTop },
        { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, page, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...item,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.024)),
        hRatio: 0.012,
        source: "segment-choice-anchor",
        anchorMode: "center",
        layout: "grid",
        confidence: 0.55,
        inferred: true,
      }));
      continue;
    }
    if (fallbackSegment.continuation === true && width < 0.70 && height >= 0.260 && choiceCount === 4) {
      const xLeft = clampGeneratedRatio(left + width * 0.110, left + width * 0.040, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.530, left + width * 0.36, right - width * 0.080);
      const yTop = clampGeneratedRatio(top + height * 0.620, top + height * 0.36, bottom - height * 0.18);
      const yBottom = clampGeneratedRatio(top + height * 0.865, yTop + 0.045, bottom - 0.012);
      out[String(q)] = [
        { choice: 1, page, xRatio: xLeft, yRatio: yTop },
        { choice: 2, page, xRatio: xRight, yRatio: yTop },
        { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, page, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...item,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.024)),
        hRatio: 0.012,
        source: "segment-choice-anchor",
        anchorMode: "center",
        layout: "grid",
        confidence: 0.56,
        inferred: true,
      }));
      continue;
    } // SOFTM-문항앵커: continuation 안의 2x2 이미지 선택지는 grid fallback으로 문항영역 생성 기준점을 제공 - 2026-06-17
    let gap = NaN;
    let firstY = NaN;
    let x = NaN;
    let confidence = 0.58;
    if (fallbackSegment.continuation === true && width < 0.70 && height >= 0.105 && height <= 0.220 && bottom >= 0.850) {
      // SOFTM-문항앵커: 현재 단 하단 코드블록을 1~4 세로 보기로 오인하지 않도록 불렛 없는 세로 fallback은 continuation에만 허용 - 2026-06-18
      gap = clampGeneratedRatio(height * 0.12, 0.014, 0.022);
      const firstYMin = top + height * 0.52;
      const firstYMax = bottom - (gap * Math.max(1, choiceCount - 1)) - 0.006;
      firstY = clampGeneratedRatio(bottom - (gap * (choiceCount - 0.45)), firstYMin, Math.max(firstYMin, firstYMax));
      x = clampGeneratedRatio(left + width * 0.087, left + width * 0.045, right - width * 0.10);
    } else if (width >= 0.70 && height >= 0.110 && height <= 0.155 && choiceCount === 4) {
      const xLeft = clampGeneratedRatio(left + width * 0.095, left + width * 0.055, right - width * 0.58);
      const xRight = clampGeneratedRatio(left + width * 0.522, left + width * 0.36, right - width * 0.10);
      const yTop = clampGeneratedRatio(top + height * 0.430, top + height * 0.34, bottom - height * 0.34); // SOFTM-문항앵커: 전폭 2행 선택지 fallback이 아래 행으로 한 줄 밀리는 현상 보정 - 2026-06-17
      const yBottom = clampGeneratedRatio(top + height * 0.780, yTop + Math.max(0.020, height * 0.16), bottom - 0.008);
      out[String(q)] = [
        { choice: 1, page, xRatio: xLeft, yRatio: yTop },
        { choice: 2, page, xRatio: xRight, yRatio: yTop },
        { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
        { choice: 4, page, xRatio: xRight, yRatio: yBottom },
      ].map((item) => ({
        ...item,
        wRatio: Math.max(0.010, Math.min(0.022, width * 0.018)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-grid",
        anchorMode: "center",
        layout: "grid",
        confidence: 0.55,
        inferred: true,
      }));
      continue;
      // SOFTM-문항앵커: 전폭 짧은 2행 선택지는 세로 4행 추정 전에 2x2 grid fallback으로 배치 - 2026-06-17
    } else if (width >= 0.70 && height >= 0.110 && height <= 0.260) {
      gap = clampGeneratedRatio(height * 0.205, 0.020, 0.042);
      const firstYMin = top + height * 0.30;
      const firstYMax = bottom - (gap * Math.max(1, choiceCount - 1)) - 0.012;
      firstY = clampGeneratedRatio(top + height * 0.36, firstYMin, Math.max(firstYMin, firstYMax));
      x = clampGeneratedRatio(left + width * 0.064, left + width * 0.040, right - width * 0.18);
      confidence = 0.54;
    } else {
      continue;
    }
    const anchors = [];
    for (let choice = 1; choice <= choiceCount; choice += 1){
      const y = clampGeneratedRatio(firstY + (choice - 1) * gap, top + 0.020, bottom - 0.006);
      anchors.push({
        choice,
        page,
        xRatio: x,
        yRatio: y,
        wRatio: Math.max(0.010, Math.min(0.020, width * 0.020)),
        hRatio: 0.012,
        source: "segment-choice-anchor",
        anchorMode: "center",
        layout: "vertical",
        confidence,
        inferred: true,
      });
    }
    if (anchors.length) out[String(q)] = anchors;
  }
  return out;
}
/* SOFTM-문항앵커: 2단 하단/1단 세로형 문항에서 이미지/OCR 선택지 앵커가 비면 segment 내부 기준 앵커를 보수 생성 - 2026-06-17 */

function snapFallbackChoiceAnchorsToRawCandidates(choiceMap, rawChoiceCandidates, questionSegments, questionColumnBoundsMap, questionCount, choiceCount){
  const out = {};
  const candidatesByPageChoice = new Map();
  for (const item of Array.isArray(rawChoiceCandidates) ? rawChoiceCandidates : []) {
    const page = Number(item?.page);
    const choice = Number(item?.choice);
    const x = Number(item?.xRatio);
    const y = Number(item?.yRatio);
    if (!Number.isFinite(page) || !Number.isInteger(choice) || choice < 1 || choice > choiceCount || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = `${page}:${choice}`;
    if (!candidatesByPageChoice.has(key)) candidatesByPageChoice.set(key, []);
    candidatesByPageChoice.get(key).push(item);
  }
  const segmentFor = (q, page, anchor = null) => {
    const segments = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : [];
    const samePage = segments.filter((segment) => Number(segment?.page) === Number(page));
    const ax = Number(anchor?.xRatio);
    const ay = Number(anchor?.yRatio);
    const picked = samePage.find((segment) => {
      const left = Number.isFinite(Number(segment?.left)) ? Number(segment.left) : 0;
      const right = Number.isFinite(Number(segment?.right)) ? Number(segment.right) : 1;
      const top = Number.isFinite(Number(segment?.top)) ? Number(segment.top) : 0;
      const bottom = Number.isFinite(Number(segment?.bottom)) ? Number(segment.bottom) : 1;
      return (!Number.isFinite(ax) || (ax >= left - 0.025 && ax <= right + 0.025))
        && (!Number.isFinite(ay) || (ay >= top - 0.030 && ay <= bottom + 0.040));
    }) || samePage[0] || segments[0] || {};
    const bounds = questionColumnBoundsMap?.[String(q)] || {};
    return {
      left: clampGeneratedRatio(picked.left ?? bounds.left ?? 0, 0, 1),
      right: clampGeneratedRatio(picked.right ?? bounds.right ?? 1, 0, 1),
      top: clampGeneratedRatio(picked.top ?? 0, 0, 1),
      bottom: clampGeneratedRatio(picked.bottom ?? 1, 0, 1),
    };
  };
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (!anchors.length) continue;
    out[String(q)] = anchors.map((anchor) => {
      const source = String(anchor?.source || "");
      if (source.includes("collapsed-column")) return anchor; // SOFTM-문항앵커: column grid 재배치 앵커는 코드블록 내부 raw 후보로 다시 끌려가지 않게 고정 - 2026-06-18
      if (!source.startsWith("segment-choice-anchor") || anchor?.inferred !== true) return anchor;
      const page = Number(anchor.page);
      const choice = Number(anchor.choice);
      const ax = Number(anchor.xRatio);
      const ay = Number(anchor.yRatio);
      if (!Number.isFinite(page) || !Number.isInteger(choice) || !Number.isFinite(ax) || !Number.isFinite(ay)) return anchor;
      const segment = segmentFor(q, page, anchor);
      const candidates = candidatesByPageChoice.get(`${page}:${choice}`) || [];
      let best = null;
      let bestScore = Infinity;
      for (const candidate of candidates) {
        const x = Number(candidate.xRatio);
        const y = Number(candidate.yRatio);
        if (x < segment.left - 0.010 || x > segment.right + 0.010 || y < segment.top - 0.006 || y > segment.bottom + 0.006) continue;
        const dx = Math.abs(x - ax);
        const dy = Math.abs(y - ay);
        const isTextGridFallback = source.includes("text-grid"); // SOFTM-문항앵커: text-grid 보수 앵커는 본문 글자 raw 후보로 멀리 끌려가지 않도록 snap 허용폭 축소 - 2026-06-18
        if (dx > (isTextGridFallback ? 0.030 : 0.060) || dy > (isTextGridFallback ? 0.030 : 0.045)) continue;
        const score = dx * 1.8 + dy;
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (!best) return anchor;
      return {
        ...anchor,
        xRatio: clampGeneratedRatio(best.xRatio),
        yRatio: clampGeneratedRatio(best.yRatio),
        wRatio: Math.max(0.008, Math.min(0.026, Number(best.wRatio) || Number(anchor.wRatio) || 0.012)),
        hRatio: Math.max(0.008, Math.min(0.026, Number(best.hRatio) || Number(anchor.hRatio) || 0.012)),
        source: `${source}-raw-snap`,
        confidence: Math.max(Number(anchor.confidence) || 0.54, 0.68),
      };
    });
  }
  return out;
}
// SOFTM-문항앵커: segment 비율 fallback 앵커는 같은 문제 범위 안의 OCR 보기 후보가 있으면 실제 원형 후보 좌표로 보정 - 2026-06-18

async function snapFallbackChoiceAnchorsToRenderedMarks(pageDir, choiceMap, questionSegments, questionCount, choiceCount){
  const mapPath = path.join(pageDir, "choice-anchor-snap-input.json");
  await fsp.writeFile(mapPath, JSON.stringify({ choiceMap, questionSegments, questionCount, choiceCount }), "utf8");
  const script = `
import json, math, os, re, sys
from collections import deque
from PIL import Image
import numpy as np

page_dir, map_path = sys.argv[1], sys.argv[2]
meta = json.load(open(map_path, "r", encoding="utf-8"))
choice_map = meta.get("choiceMap") or {}
segments_map = meta.get("questionSegments") or {}
question_count = int(meta.get("questionCount") or 0)
choice_count = max(1, min(5, int(meta.get("choiceCount") or 4)))

def page_no_from_name(name, fallback=0):
    matches = re.findall(r'(\\d+)', str(name))
    return int(matches[-1]) if matches else fallback

page_files = {}
for fallback_page_no, name in enumerate(sorted([n for n in os.listdir(page_dir) if n.lower().endswith(".png")]), start=1):
    page_files[page_no_from_name(name, fallback_page_no)] = os.path.join(page_dir, name)

def clamp(value, lo, hi):
    try:
        value = float(value)
    except Exception:
        return lo
    return max(lo, min(hi, value))

def segment_for(q, page, anchor=None):
    segments = segments_map.get(str(q)) or []
    same_page = []
    for item in segments if isinstance(segments, list) else []:
        try:
            if int(item.get("page") or 0) == int(page):
                same_page.append(item)
        except Exception:
            continue
    ax = None
    ay = None
    try:
        ax = float(anchor.get("xRatio")) if anchor else None
        ay = float(anchor.get("yRatio")) if anchor else None
    except Exception:
        ax = ay = None
    def contains(item):
        try:
            left = float(item.get("left", 0.0))
            right = float(item.get("right", 1.0))
            top = float(item.get("top", 0.0))
            bottom = float(item.get("bottom", 1.0))
        except Exception:
            return False
        return (ax is None or left - 0.035 <= ax <= right + 0.035) and (ay is None or top - 0.040 <= ay <= bottom + 0.060)
    picked = next((item for item in same_page if contains(item)), None) or (same_page[0] if same_page else {})
    return {
        "left": clamp(picked.get("left", 0.0), 0.0, 1.0),
        "right": clamp(picked.get("right", 1.0), 0.0, 1.0),
        "top": clamp(picked.get("top", 0.0), 0.0, 1.0),
        "bottom": clamp(picked.get("bottom", 1.0), 0.0, 1.0),
    }

def should_snap(anchor):
    source = str(anchor.get("source") or "").lower()
    layout = str(anchor.get("layout") or "").lower()
    if not (source.startswith("segment-choice-anchor") or source.startswith("anchor-image")):
        return False
    if "pixel-snap" in source or "collapsed-column" in source:
        return False
    if layout == "vertical":
        return bool(anchor.get("inferred") is True or source.startswith("segment-choice-anchor") or "post-" in source)
    # SOFTM-문항앵커: 세로형 fallback도 실제 원형 픽셀로 재확인하되 안정적인 anchor-image 세로 앵커는 원래 x축을 보존 - 2026-06-19
    return bool(anchor.get("inferred") is True or "text-" in source or source.startswith("anchor-image"))

def expected_anchor_xs(anchor, segment):
    try:
        choice = int(anchor.get("choice") or 0)
    except Exception:
        return []
    if choice < 1 or choice > choice_count:
        return []
    left = float(segment["left"])
    right = float(segment["right"])
    width = max(0.05, right - left)
    layout = str(anchor.get("layout") or "").lower()
    if layout == "vertical":
        try:
            current_x = float(anchor.get("xRatio") or 0)
            # SOFTM-문항앵커: 세로형 추정 앵커는 기하 슬롯이 아니라 현재 행 주변 실제 원형 후보로만 스냅 - 2026-06-19
            return [clamp(current_x, left + 0.015, right - 0.015)]
        except Exception:
            return []
    horizontal_slots = [0.0965, 0.3095, 0.5225, 0.7340]
    grid_slots = [0.0965, 0.5225, 0.0965, 0.5225]
    xs = []
    if layout == "grid":
        xs.append(left + width * grid_slots[choice - 1])
    else:
        xs.append(left + width * horizontal_slots[choice - 1])
    try:
        current_x = float(anchor.get("xRatio") or 0)
        xs.append(current_x)
    except Exception:
        pass
    out = []
    for x in xs:
        x = clamp(x, left + 0.015, right - 0.015)
        if not any(abs(x - old) < 0.004 for old in out):
            out.append(x)
    return out

def grid_slot_ratio(segment, slot):
    left = float(segment["left"])
    right = float(segment["right"])
    width = max(0.05, right - left)
    return clamp(left + width * slot, left + 0.015, right - 0.015)

def connected_components(mask):
    h, w = mask.shape
    visited = np.zeros((h, w), dtype=bool)
    comps = []
    for y0 in range(h):
        for x0 in range(w):
            if visited[y0, x0] or not mask[y0, x0]:
                continue
            q = deque([(x0, y0)])
            visited[y0, x0] = True
            xs = []
            ys = []
            while q:
                x, y = q.popleft()
                xs.append(x)
                ys.append(y)
                for ny in (y - 1, y, y + 1):
                    for nx in (x - 1, x, x + 1):
                        if nx == x and ny == y:
                            continue
                        if nx < 0 or ny < 0 or nx >= w or ny >= h or visited[ny, nx] or not mask[ny, nx]:
                            continue
                        visited[ny, nx] = True
                        q.append((nx, ny))
            comps.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, len(xs)))
    return comps

def find_mark_center(arr, anchor, segment):
    h, w = arr.shape
    ax = float(anchor.get("xRatio") or 0) * w
    ay = float(anchor.get("yRatio") or 0) * h
    seg_left = float(segment["left"]) * w
    seg_right = float(segment["right"]) * w
    seg_top = float(segment["top"]) * h
    seg_bottom = float(segment["bottom"]) * h
    layout = str(anchor.get("layout") or "").lower()
    source = str(anchor.get("source") or "").lower()
    is_leading_probe = layout == "vertical" and "post-inferred-leading" in source
    x_radius = max(34, min(72, w * (0.035 if layout == "grid" else 0.030)))
    y_radius = max(26, min(58, h * (0.020 if layout == "grid" else 0.016)))
    if layout == "vertical" and "post-inferred-leading" in source:
        y_radius = max(y_radius, min(92, h * 0.030))
        # SOFTM-문항앵커: 선두 복원 ①은 행 간격 추정이 위로 치우칠 수 있어 실제 원형까지 세로 snap 탐색을 넓힘 - 2026-06-19
    x0 = int(max(seg_left, ax - x_radius))
    x1 = int(min(seg_right, ax + x_radius))
    y0 = int(max(seg_top, ay - y_radius))
    y1 = int(min(seg_bottom, ay + y_radius))
    if x1 - x0 < 18 or y1 - y0 < 14:
        return None
    local = arr[y0:y1, x0:x1]
    dark = local < 138
    # 작은 노이즈를 줄이되, 원형 숫자 획은 보존한다.
    comps = connected_components(dark)
    candidates = []
    for lx0, ly0, lx1, ly1, area in comps:
        bw = lx1 - lx0
        bh = ly1 - ly0
        if bw < 5 or bh < 6 or bw > 34 or bh > 34:
            continue
        density = area / max(1, bw * bh)
        if density < 0.08 or density > 0.72:
            continue
        aspect = bw / max(1, bh)
        if aspect < 0.48 or aspect > 1.85:
            continue
        cx = x0 + (lx0 + lx1) * 0.5
        cy = y0 + (ly0 + ly1) * 0.5
        if cx < seg_left - 1 or cx > seg_right + 1 or cy < seg_top - 1 or cy > seg_bottom + 1:
            continue
        dx = abs(cx - ax)
        dy = abs(cy - ay)
        if dx > x_radius * 0.90 or dy > y_radius * 0.90:
            continue
        if is_leading_probe and cy < ay - y_radius * 0.30:
            # SOFTM-문항앵커: 선두 ① 복원은 문제 제목/본문 글자 조각처럼 추정점보다 크게 위인 후보를 제외 - 2026-06-19
            continue
        candidates.append({
            "lx0": lx0, "ly0": ly0, "lx1": lx1, "ly1": ly1,
            "cx": cx, "cy": cy, "bw": bw, "bh": bh, "dx": dx, "dy": dy, "aspect": aspect
        })
    if not candidates:
        return None
    candidates.sort(key=lambda item: item["cx"])
    leftmost = candidates[0]
    # SOFTM-문항앵커: 가로형 fallback이 보기 텍스트 숫자로 붙지 않도록 같은 행의 왼쪽 원형 번호 후보 묶음만 허용 - 2026-06-18
    mark_cluster_right = leftmost["cx"] + max(18, x_radius * 0.34)
    text_start_x = None
    for item in candidates[1:]:
        if item["cx"] > mark_cluster_right:
            text_start_x = item["lx0"] + x0
            break
    best = None
    best_score = 1e9
    for item in candidates:
        cx = item["cx"]
        cy = item["cy"]
        bw = item["bw"]
        bh = item["bh"]
        aspect = item["aspect"]
        dx = item["dx"]
        dy = item["dy"]
        if text_start_x is not None and cx >= text_start_x - 2:
            continue
        circular_bonus = 0 if 0.70 <= aspect <= 1.35 else 8
        size_bonus = 0 if 8 <= bw <= 26 and 8 <= bh <= 28 else 6
        left_order_bonus = max(0, cx - leftmost["cx"]) * 0.35
        # 원형 번호는 같은 행 보기 텍스트보다 왼쪽에 있으므로 텍스트 시작점 오른쪽 후보는 제외한다.
        score = dx * 1.30 + dy * 1.10 + circular_bonus + size_bonus + left_order_bonus
        if score < best_score:
            best_score = score
            best = (cx, cy, bw, bh)
    if not best:
        return None
    cx, cy, bw, bh = best
    # 과도한 이동은 본문 숫자나 선택지 텍스트 조각으로 스냅된 것으로 본다.
    move_limit = 0.96 if is_leading_probe else 0.78
    if abs(cx - ax) > x_radius * move_limit or abs(cy - ay) > y_radius * move_limit:
        return None
    return {
        "xRatio": clamp(cx / max(1, w), 0.0, 1.0),
        "yRatio": clamp(cy / max(1, h), 0.0, 1.0),
        "wRatio": clamp(max(8, bw) / max(1, w), 0.006, 0.035),
        "hRatio": clamp(max(8, bh) / max(1, h), 0.006, 0.035),
    }

def repair_false_horizontal_grid(arr, anchors, segment):
    if choice_count != 4 or len(anchors) != 4:
        return None
    by_choice = {}
    for anchor in anchors:
        try:
            by_choice[int(anchor.get("choice") or 0)] = anchor
        except Exception:
            pass
    if any(choice not in by_choice for choice in (1, 2, 3, 4)):
        return None
    layouts = [str(by_choice[choice].get("layout") or "").lower() for choice in (1, 2, 3, 4)]
    if any(layout not in ("horizontal", "") for layout in layouts):
        return None
    try:
        y_values = [float(by_choice[choice].get("yRatio") or 0) for choice in (1, 2, 3, 4)]
        if max(y_values) - min(y_values) > 0.026:
            return None
        left_slot = grid_slot_ratio(segment, 0.0965)
        right_slot = grid_slot_ratio(segment, 0.5225)
        h_slots = [grid_slot_ratio(segment, value) for value in (0.0965, 0.3095, 0.5225, 0.7340)]
        if abs(float(by_choice[1].get("xRatio") or 0) - left_slot) > 0.045:
            return None
        if abs(float(by_choice[3].get("xRatio") or 0) - right_slot) > 0.055:
            return None
        if abs(float(by_choice[2].get("xRatio") or 0) - h_slots[1]) > 0.065:
            return None
        if abs(float(by_choice[4].get("xRatio") or 0) - h_slots[3]) > 0.075:
            return None
        top_y = (float(by_choice[1].get("yRatio") or 0) + float(by_choice[3].get("yRatio") or 0)) * 0.5
        seg_top = float(segment["top"])
        seg_bottom = float(segment["bottom"])
        seg_height = max(0.0, seg_bottom - seg_top)
        w1 = float(by_choice[1].get("wRatio") or 0.012)
        w2 = float(by_choice[2].get("wRatio") or 0.012)
        w3 = float(by_choice[3].get("wRatio") or 0.012)
        w4 = float(by_choice[4].get("wRatio") or 0.012)
        s2 = str(by_choice[2].get("source") or "")
        s4 = str(by_choice[4].get("source") or "")
        small_middle = w2 < max(0.0105, w1 * 0.78) or (w2 < 0.0155 and "pixel-snap" not in s2)
        small_tail = w4 < max(0.0105, w3 * 0.78) or (w4 < 0.0155 and "pixel-snap" not in s4)
        lower_row_candidate = seg_height <= 0.165 and top_y - seg_top >= max(0.050, seg_height * 0.45) and small_middle
        if seg_bottom <= top_y + 0.040 and not lower_row_candidate:
            return None
    except Exception:
        return None

    def snapped_at(choice, x_ratio, y_ratio, base=None):
        probe = dict(base or by_choice.get(choice) or {})
        probe["choice"] = choice
        probe["layout"] = "grid"
        probe["xRatio"] = x_ratio
        probe["yRatio"] = y_ratio
        return find_mark_center(arr, probe, segment)

    def loose_grid_mark(x_ratio, y_min_ratio, y_max_ratio):
        h, w = arr.shape
        tx = float(x_ratio) * w
        x_radius = max(34, min(76, w * 0.038))
        x0 = int(max(float(segment["left"]) * w, tx - x_radius))
        x1 = int(min(float(segment["right"]) * w, tx + x_radius))
        y0 = int(max(float(segment["top"]) * h, float(y_min_ratio) * h))
        y1 = int(min(float(segment["bottom"]) * h, float(y_max_ratio) * h))
        if x1 - x0 < 18 or y1 - y0 < 16:
            return None
        comps = connected_components(arr[y0:y1, x0:x1] < 138)
        best = None
        best_score = 1e9
        for lx0, ly0, lx1, ly1, area in comps:
            bw = lx1 - lx0
            bh = ly1 - ly0
            if bw < 6 or bh < 7 or bw > 35 or bh > 35:
                continue
            density = area / max(1, bw * bh)
            if density < 0.055 or density > 0.62:
                continue
            aspect = bw / max(1, bh)
            if aspect < 0.50 or aspect > 1.72:
                continue
            cx = x0 + (lx0 + lx1) * 0.5
            cy = y0 + (ly0 + ly1) * 0.5
            dx = abs(cx - tx)
            if dx > x_radius * 0.74:
                continue
            score = dx + abs(aspect - 1.0) * 7.0 + max(0, bw - 26) * 0.7 + max(0, bh - 28) * 0.7
            if score < best_score:
                best_score = score
                best = (cx, cy, bw, bh)
        if not best:
            return None
        cx, cy, bw, bh = best
        return {
            "xRatio": clamp(cx / max(1, w), 0.0, 1.0),
            "yRatio": clamp(cy / max(1, h), 0.0, 1.0),
            "wRatio": clamp(max(8, bw) / max(1, w), 0.006, 0.035),
            "hRatio": clamp(max(8, bh) / max(1, h), 0.006, 0.035),
        }
        # SOFTM-문항앵커: 2행 grid 아래 행은 기존 anchor y 추정이 없으므로 segment 내부 원형 후보를 행 범위로 재탐색 - 2026-06-18

    top_left = snapped_at(1, left_slot, top_y, by_choice[1]) or {
        "xRatio": float(by_choice[1].get("xRatio") or left_slot),
        "yRatio": float(by_choice[1].get("yRatio") or top_y),
        "wRatio": float(by_choice[1].get("wRatio") or 0.012),
        "hRatio": float(by_choice[1].get("hRatio") or 0.012),
    }
    top_right = snapped_at(2, right_slot, top_y, by_choice[3]) or {
        "xRatio": float(by_choice[3].get("xRatio") or right_slot),
        "yRatio": float(by_choice[3].get("yRatio") or top_y),
        "wRatio": float(by_choice[3].get("wRatio") or 0.012),
        "hRatio": float(by_choice[3].get("hRatio") or 0.012),
    }

    best_pair = None
    upper_pair = None
    best_score = 1e9
    max_bottom_y = min(seg_bottom - 0.006, top_y + 0.135)
    probe_y = top_y + 0.026
    while probe_y <= max_bottom_y:
        bottom_left = snapped_at(3, left_slot, probe_y, by_choice[1])
        bottom_right = snapped_at(4, right_slot, probe_y, by_choice[3])
        if bottom_left and bottom_right:
            try:
                left_y = float(bottom_left["yRatio"])
                right_y = float(bottom_right["yRatio"])
                row_y = (left_y + right_y) * 0.5
                gap = row_y - top_y
                if gap >= 0.022 and abs(left_y - right_y) <= 0.018:
                    score = abs(left_y - right_y) * 5.0 + abs(gap - 0.055)
                    if score < best_score:
                        best_score = score
                        best_pair = (bottom_left, bottom_right, row_y)
            except Exception:
                pass
        probe_y += 0.006
    if not best_pair:
        y_min = top_y + 0.018
        y_max = min(seg_bottom + 0.008, top_y + 0.145)
        bottom_left = loose_grid_mark(left_slot, y_min, y_max)
        bottom_right = loose_grid_mark(right_slot, y_min, y_max)
        if bottom_left and bottom_right:
            try:
                left_y = float(bottom_left["yRatio"])
                right_y = float(bottom_right["yRatio"])
                row_y = (left_y + right_y) * 0.5
                if row_y - top_y >= 0.020 and abs(left_y - right_y) <= 0.022:
                    best_pair = (bottom_left, bottom_right, row_y)
            except Exception:
                best_pair = None
    if not best_pair and (seg_bottom - float(segment["top"])) <= 0.165:
        y_min = max(float(segment["top"]), top_y - 0.145)
        y_max = top_y - 0.018
        upper_left = loose_grid_mark(left_slot, y_min, y_max)
        upper_right = loose_grid_mark(right_slot, y_min, y_max)
        if upper_left and upper_right:
            try:
                left_y = float(upper_left["yRatio"])
                right_y = float(upper_right["yRatio"])
                row_y = (left_y + right_y) * 0.5
                if top_y - row_y >= 0.020 and abs(left_y - right_y) <= 0.022:
                    upper_pair = (upper_left, upper_right, row_y)
            except Exception:
                upper_pair = None
        # SOFTM-문항앵커: 아래 행 ③④를 ①③으로 잡은 짧은 2행 문제는 위 행 ①②를 역방향으로 찾아 grid를 복구 - 2026-06-18
    if not best_pair and not upper_pair:
        try:
            suspicious_middle_text = lower_row_candidate and (small_middle or small_tail)
            inferred_gap = clamp((top_y - float(segment["top"])) * 0.42, 0.026, 0.045)
            inferred_y = top_y - inferred_gap
            if suspicious_middle_text and inferred_y > float(segment["top"]) + 0.020:
                upper_pair = (
                    {"xRatio": left_slot, "yRatio": inferred_y, "wRatio": max(0.010, w1), "hRatio": max(0.010, float(by_choice[1].get("hRatio") or 0.012))},
                    {"xRatio": right_slot, "yRatio": inferred_y, "wRatio": max(0.010, w3), "hRatio": max(0.010, float(by_choice[3].get("hRatio") or 0.012))},
                    inferred_y,
                )
        except Exception:
            upper_pair = None
        # SOFTM-문항앵커: 짧은 2행 선택지에서 2번 위치가 본문 조각이면 현재 행을 아래 행으로 보고 위 행을 보간 - 2026-06-18
    if not best_pair:
        if not upper_pair:
            return None
        upper_left, upper_right, _ = upper_pair
        bottom_left = top_left
        bottom_right = top_right
        top_left = upper_left
        top_right = upper_right
    else:
        bottom_left, bottom_right, _ = best_pair

    source = f"{by_choice[1].get('source') or 'anchor-image'}-grid-row-repair"
    repaired = []
    for choice, base_anchor, snap in [
        (1, by_choice[1], top_left),
        (2, by_choice[3], top_right),
        (3, by_choice[1], bottom_left),
        (4, by_choice[3], bottom_right),
    ]:
        item = dict(base_anchor)
        item.update(snap)
        item["choice"] = choice
        item["layout"] = "grid"
        item["source"] = source
        item["confidence"] = max(float(base_anchor.get("confidence") or 0.54), 0.70)
        repaired.append(item)
    return repaired
    # SOFTM-문항앵커: 2행 선택지를 한 줄 horizontal로 오판하고 2/4번을 본문 글자로 스냅한 경우 실제 아래 행 원형을 찾아 grid로 복구 - 2026-06-18

out = {}
image_cache = {}
for q in range(1, question_count + 1):
    anchors = [dict(item) for item in (choice_map.get(str(q)) or []) if isinstance(item, dict)]
    if not anchors:
        continue
    next_anchors = []
    for anchor in anchors:
        if not should_snap(anchor):
            next_anchors.append(anchor)
            continue
        try:
            page = int(anchor.get("page") or 0)
            choice = int(anchor.get("choice") or 0)
        except Exception:
            next_anchors.append(anchor)
            continue
        if page <= 0 or choice < 1 or choice > choice_count or page not in page_files:
            next_anchors.append(anchor)
            continue
        if page not in image_cache:
            image_cache[page] = np.array(Image.open(page_files[page]).convert("L"))
        segment = segment_for(q, page, anchor)
        snap = None
        for expected_x in expected_anchor_xs(anchor, segment):
            probe = dict(anchor)
            probe["xRatio"] = expected_x
            candidate = find_mark_center(image_cache[page], probe, segment)
            if candidate:
                snap = candidate
                break
        # SOFTM-문항앵커: 현재 위치가 텍스트 쪽이어도 choice 기대 위치 주변의 원형 번호 후보를 먼저 탐색 - 2026-06-18
        if not snap:
            next_anchors.append(anchor)
            continue
        moved = dict(anchor)
        moved.update(snap)
        moved["source"] = f"{anchor.get('source') or 'segment-choice-anchor'}-pixel-snap"
        moved["confidence"] = max(float(anchor.get("confidence") or 0.54), 0.66)
        next_anchors.append(moved)
    if next_anchors:
        try:
            page = int(next_anchors[0].get("page") or 0)
            if page > 0 and page in page_files:
                if page not in image_cache:
                    image_cache[page] = np.array(Image.open(page_files[page]).convert("L"))
                segment = segment_for(q, page, next_anchors[0])
                repaired_grid = repair_false_horizontal_grid(image_cache[page], next_anchors, segment)
                if repaired_grid:
                    next_anchors = repaired_grid
        except Exception:
            pass
    if next_anchors:
        out[str(q)] = sorted(next_anchors, key=lambda item: int(item.get("choice") or 0))

print(json.dumps(out, ensure_ascii=False))
`;
  const result = await run("python3", ["-c", script, pageDir, mapPath], { maxBuffer: 40 * 1024 * 1024 });
  return JSON.parse(result.stdout || "{}");
}
// SOFTM-문항앵커: segment fallback 앵커는 렌더 PNG 주변의 실제 원형/숫자 픽셀 후보로 한 번 더 스냅 - 2026-06-18

function repairBoxOptionUpperGridChoiceMap(choiceMap, questionSegments, questionCount, choiceCount){
  const out = {};
  const slotX = [0.0965, 0.3095, 0.5225, 0.7340];
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (choiceCount !== 4 || anchors.length !== 4) {
      if (anchors.length) out[String(q)] = anchors;
      continue;
    }
    const ordered = anchors
      .filter((item) => Number.isInteger(Number(item.choice)) && Number(item.choice) >= 1 && Number(item.choice) <= 4)
      .sort((a, b) => Number(a.choice) - Number(b.choice));
    if (ordered.length !== 4) {
      out[String(q)] = anchors;
      continue;
    }
    const sources = ordered.map((item) => String(item.source || ""));
    if (!sources.slice(0, 2).every((source) => source.includes("inferred-upper-grid"))) {
      out[String(q)] = anchors;
      continue;
    }
    const page = Number(ordered[0].page);
    const lower = ordered.slice(2);
    const lowerY = lower.map((item) => Number(item.yRatio));
    const upperY = ordered.slice(0, 2).map((item) => Number(item.yRatio));
    if (
      !Number.isFinite(page)
      || lowerY.some((value) => !Number.isFinite(value))
      || upperY.some((value) => !Number.isFinite(value))
      || Math.max(...lowerY) - Math.min(...lowerY) > 0.018
      || Math.min(...lowerY) - Math.max(...upperY) < 0.024
    ) {
      out[String(q)] = anchors;
      continue;
    }
    const lowerXs = lower.map((item) => Number(item.xRatio));
    if (Math.abs(lowerXs[0] - slotX[0]) > 0.045 || Math.abs(lowerXs[1] - slotX[2]) > 0.055) {
      out[String(q)] = anchors;
      continue;
    }
    const segments = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : [];
    const segment = segments.find((item) => Number(item.page) === page) || segments[0] || null;
    const segmentTop = Number(segment?.top);
    const segmentBottom = Number(segment?.bottom);
    const rowY = lowerY.reduce((sum, value) => sum + value, 0) / lowerY.length;
    if (Number.isFinite(segmentTop) && Number.isFinite(segmentBottom) && segmentBottom - segmentTop < 0.145) {
      out[String(q)] = anchors;
      continue;
    }
    // SOFTM-문항앵커: 짧은 일반 2행 선택지는 박스형 선택지 행으로 오판해 한 줄로 펴지 않도록 제외 - 2026-06-18
    if (!Number.isFinite(segmentTop) || !Number.isFinite(segmentBottom) || rowY < segmentTop || rowY > segmentBottom + 0.012) {
      out[String(q)] = anchors;
      continue;
    }
    out[String(q)] = slotX.map((xRatio, index) => ({
      ...(index === 0 ? lower[0] : index === 2 ? lower[1] : lower[index > 1 ? 1 : 0]),
      choice: index + 1,
      xRatio,
      yRatio: rowY,
      wRatio: index === 0 ? Number(lower[0].wRatio || 0.012) : index === 2 ? Number(lower[1].wRatio || 0.012) : 0.012,
      hRatio: index === 0 ? Number(lower[0].hRatio || 0.012) : index === 2 ? Number(lower[1].hRatio || 0.012) : 0.012,
      layout: "horizontal",
      source: "segment-choice-anchor-text-horizontal-box-row",
      inferred: index === 1 || index === 3,
      confidence: index === 1 || index === 3 ? 0.60 : Math.max(Number(lower[index === 0 ? 0 : 1].confidence) || 0.62, 0.66),
    }));
    // SOFTM-문항앵커: 박스 안 ㄱ/ㄴ/ㄷ/ㄹ 설명 후보를 ①②로 오인한 경우 아래 실제 선택지 행으로 재구성 - 2026-06-18
  }
  return out;
}

function alignGridFallbackRowsToSnappedSiblings(choiceMap, questionCount, choiceCount){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (choiceCount !== 4 || anchors.length !== 4 || !anchors.every((item) => String(item?.layout || "") === "grid")) {
      if (anchors.length) out[String(q)] = anchors;
      continue;
    }
    const byChoice = new Map(anchors.map((item) => [Number(item.choice), item]));
    for (const [leftChoice, rightChoice] of [[1, 2], [3, 4]]){
      const left = byChoice.get(leftChoice);
      const right = byChoice.get(rightChoice);
      const leftY = Number(left?.yRatio);
      const rightY = Number(right?.yRatio);
      if (!left || !right || !Number.isFinite(leftY) || !Number.isFinite(rightY) || Math.abs(leftY - rightY) <= 0.010) continue;
      const leftSource = String(left.source || "");
      const rightSource = String(right.source || "");
      const leftSnapped = leftSource.includes("pixel-snap");
      const rightSnapped = rightSource.includes("pixel-snap");
      if (leftSnapped === rightSnapped) continue;
      const source = leftSnapped ? left : right;
      const target = leftSnapped ? right : left;
      target.yRatio = source.yRatio;
      target.hRatio = source.hRatio || target.hRatio;
      target.source = `${target.source || "segment-choice-anchor-text-grid"}-row-align`;
      target.confidence = Math.max(Number(target.confidence) || 0.55, Math.min(0.68, Number(source.confidence) || 0.66));
    }
    out[String(q)] = anchors.sort((a, b) => Number(a.choice) - Number(b.choice));
  }
  return out;
}
// SOFTM-문항앵커: grid fallback의 한쪽 앵커가 본문 글자에 남아 있으면 실제 스냅된 형제 row 기준으로 높이를 보정 - 2026-06-19

/* SOFTM-문항영역 시작: 위치맵 생성 단계에서 렌더 PNG 픽셀 기반 정밀 문항영역을 생성 - 2026-06-16 */
async function buildPreciseChoiceClickAreaMapFromRenderedPages(pageDir, choiceAnchorMap, questionSegments, questionColumnBoundsMap, questionLabelMap, questionCount, choiceCount){
  const mapPath = path.join(pageDir, "choice-area-input.json");
  await fsp.writeFile(mapPath, JSON.stringify({ choiceAnchorMap, questionSegments, questionColumnBoundsMap, questionLabelMap, questionCount, choiceCount }), "utf8");
  const script = `
import json, math, os, re, sys
from PIL import Image
import numpy as np

page_dir, map_path = sys.argv[1], sys.argv[2]
meta = json.load(open(map_path, "r", encoding="utf-8"))
choice_map = meta.get("choiceAnchorMap") or {}
segments_map = meta.get("questionSegments") or {}
column_bounds_map = meta.get("questionColumnBoundsMap") or {}
question_label_map = meta.get("questionLabelMap") or {}
question_count = int(meta.get("questionCount") or 0)
choice_count = max(1, min(5, int(meta.get("choiceCount") or 4)))

def clamp(value, lo, hi):
    try:
        value = float(value)
    except Exception:
        return lo
    return max(lo, min(hi, value))

def median(values, fallback):
    values = sorted([float(v) for v in values if isinstance(v, (int, float)) and math.isfinite(float(v))])
    return values[len(values) // 2] if values else fallback

def page_no_from_name(name, fallback=0):
    matches = re.findall(r'(\\d+)', str(name))
    return int(matches[-1]) if matches else fallback

page_files = {}
for fallback_page_no, name in enumerate(sorted([n for n in os.listdir(page_dir) if n.lower().endswith(".png")]), start=1):
    page_files[page_no_from_name(name, fallback_page_no)] = os.path.join(page_dir, name)

def segment_for(q, page, anchor=None):
    segments = segments_map.get(str(q)) or []
    same_page = []
    for item in segments if isinstance(segments, list) else []:
        try:
            if int(item.get("page") or 0) == int(page):
                same_page.append(item)
        except Exception:
            continue
    ax = None
    ay = None
    try:
        ax = float(anchor.get("xRatio")) if anchor else None
        ay = float(anchor.get("yRatio")) if anchor else None
    except Exception:
        ax = ay = None
    def contains(item, check_y=True):
        try:
            left = float(item.get("left", 0.0))
            right = float(item.get("right", 1.0))
            top = float(item.get("top", 0.0))
            bottom = float(item.get("bottom", 1.0))
        except Exception:
            return False
        return (ax is None or (left - 0.030 <= ax <= right + 0.030)) and (not check_y or ay is None or (top - 0.035 <= ay <= bottom + 0.055))
    picked = next((item for item in same_page if contains(item, True)), None) or next((item for item in same_page if contains(item, False)), None) or (same_page[0] if same_page else None)
    bounds = column_bounds_map.get(str(q)) or {}
    base = picked or {}
    left = clamp(base.get("left", bounds.get("left", 0.0)), 0.0, 1.0)
    right = clamp(base.get("right", bounds.get("right", 1.0)), 0.0, 1.0)
    top = clamp(base.get("top", 0.035), 0.0, 1.0)
    bottom = clamp(base.get("bottom", 0.965), 0.0, 1.0)
    # SOFTM-문항영역: 저장 segment 하단은 다음 문제 hard boundary이므로 픽셀 영역 생성 중 문항앵커나 다음 라벨로 다시 확장하지 않음 - 2026-06-17
    return {
        "top": top,
        "bottom": bottom, # SOFTM-문항영역: 클릭 영역은 segment 패딩 하단이 아니라 다음 문제 라벨 직전까지 마지막 보기를 허용 - 2026-06-17
        "left": left,
        "right": right,
    }

def layout_for(anchors):
    counts = {}
    for anchor in anchors:
        layout = str(anchor.get("layout") or "")
        if layout:
            counts[layout] = counts.get(layout, 0) + 1
    return sorted(counts.items(), key=lambda item: item[1], reverse=True)[0][0] if counts else ""

def rows_for(anchors):
    layout = layout_for(anchors)
    ordered = sorted(anchors, key=lambda item: (float(item.get("yRatio") or 0), float(item.get("xRatio") or 0)))
    if layout == "vertical":
        return [[item] for item in ordered]
    if layout == "horizontal":
        return [sorted(ordered, key=lambda item: float(item.get("xRatio") or 0))]
    if layout == "grid" and choice_count == 4:
        top = sorted([item for item in ordered if int(item.get("choice") or 0) in (1, 2)], key=lambda item: float(item.get("xRatio") or 0))
        bottom = sorted([item for item in ordered if int(item.get("choice") or 0) in (3, 4)], key=lambda item: float(item.get("xRatio") or 0))
        return [row for row in (top, bottom) if row]
    rows = []
    for anchor in ordered:
        y = float(anchor.get("yRatio") or 0)
        target = None
        for row in rows:
            row_y = median([float(item.get("yRatio") or 0) for item in row], y)
            if abs(row_y - y) <= 0.010:
                target = row
                break
        if target is None:
            target = []
            rows.append(target)
        target.append(anchor)
    return [sorted(row, key=lambda item: float(item.get("xRatio") or 0)) for row in rows]

def is_dark_array(arr):
    return arr < 185

def longest_run(values):
    best = 0
    current = 0
    for value in values:
        if value:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best

def find_text_bounds(arr, x0, y0, x1, y1):
    h, w = arr.shape
    x0 = max(0, min(w, int(math.floor(x0))))
    x1 = max(0, min(w, int(math.ceil(x1))))
    y0 = max(0, min(h, int(math.floor(y0))))
    y1 = max(0, min(h, int(math.ceil(y1))))
    if x1 - x0 < 16 or y1 - y0 < 10:
        return None
    dark = is_dark_array(arr[y0:y1, x0:x1])
    total = int(np.sum(dark))
    local_h, local_w = dark.shape
    if total < max(8, min(64, int(local_w * local_h * 0.0015))):
        return None
    row_counts = np.sum(dark, axis=1)
    col_counts = np.sum(dark, axis=0)
    row_line_limit = max(24, local_w * 0.72)
    col_line_limit = max(24, local_h * 0.72)
    row_is_line = np.zeros(local_h, dtype=bool)
    col_is_line = np.zeros(local_w, dtype=bool)
    for y in range(local_h):
        if row_counts[y] >= row_line_limit and longest_run(dark[y, :]) >= row_line_limit:
            row_is_line[y] = True
    for x in range(local_w):
        if col_counts[x] >= col_line_limit and longest_run(dark[:, x]) >= col_line_limit:
            col_is_line[x] = True
    kept = dark.copy()
    if local_h:
        kept[row_is_line, :] = False
    if local_w:
        kept[:, col_is_line] = False
    ys, xs = np.where(kept)
    if len(xs) < max(8, total * 0.12):
        return None
    row_has_text = np.zeros(local_h, dtype=bool)
    row_has_text[ys] = True
    line_count = 0
    last_row = -999
    merge_gap = max(8, int(local_h * 0.120))
    for row_idx in np.where(row_has_text)[0]:
        if row_idx - last_row > merge_gap:
            line_count += 1
        last_row = int(row_idx)
    return {
        "x": x0 + int(xs.min()),
        "y": y0 + int(ys.min()),
        "w": int(xs.max() - xs.min() + 1),
        "h": int(ys.max() - ys.min() + 1),
        "lineCount": max(1, int(line_count)),
    }

def looks_like_visual_choice_cell(arr, x0, y0, x1, y1):
    # SOFTM-문항영역 시작: 이미지/코드형 선택지 cell만 구조 영역으로 확장하기 위한 프레임 픽셀 판별 - 2026-06-19
    h, w = arr.shape
    x0 = max(0, min(w, int(math.floor(x0))))
    x1 = max(0, min(w, int(math.ceil(x1))))
    y0 = max(0, min(h, int(math.floor(y0))))
    y1 = max(0, min(h, int(math.ceil(y1))))
    if x1 - x0 < 28 or y1 - y0 < 46:
        return False
    dark = is_dark_array(arr[y0:y1, x0:x1])
    local_h, local_w = dark.shape
    if local_h < 46 or local_w < 28:
        return False
    row_counts = np.sum(dark, axis=1)
    col_counts = np.sum(dark, axis=0)
    strong_rows = [idx for idx, count in enumerate(row_counts) if count >= max(16, local_w * 0.42) and longest_run(dark[idx, :]) >= max(16, local_w * 0.34)]
    strong_cols = [idx for idx, count in enumerate(col_counts) if count >= max(18, local_h * 0.34) and longest_run(dark[:, idx]) >= max(18, local_h * 0.28)]
    top_h = min(local_h, max(34, int(local_h * 0.34)))
    top_dark = dark[:top_h, :]
    top_row_counts = np.sum(top_dark, axis=1)
    top_col_counts = np.sum(top_dark, axis=0)
    top_strong_rows = [idx for idx, count in enumerate(top_row_counts) if count >= max(16, local_w * 0.42) and longest_run(top_dark[idx, :]) >= max(16, local_w * 0.34)]
    top_strong_cols = [idx for idx, count in enumerate(top_col_counts) if count >= max(12, top_h * 0.32) and longest_run(top_dark[:, idx]) >= max(12, top_h * 0.26)]
    ys, xs = np.where(dark)
    if len(xs) < max(24, local_w * local_h * 0.006):
        return False
    bbox_h = int(ys.max() - ys.min() + 1)
    has_near_top_frame = len(top_strong_rows) >= 1 or len(top_strong_cols) >= 1
    return has_near_top_frame and bbox_h >= max(42, local_h * 0.45) and (len(strong_rows) >= 1 or len(strong_cols) >= 2)
    # SOFTM-문항영역 끝

def make_area(q, choice, page, rect, source, confidence):
    image_path = page_files.get(int(page))
    if not image_path:
        return None
    with Image.open(image_path) as im:
        w, h = im.size
    x = clamp(rect["x"] / max(1, w), 0.0, 1.0)
    y = clamp(rect["y"] / max(1, h), 0.0, 1.0)
    ww = clamp(rect["w"] / max(1, w), 0.001, 1.0 - x)
    hh = clamp(rect["h"] / max(1, h), 0.001, 1.0 - y)
    if ww <= 0 or hh <= 0:
        return None
    return {
        "q": q,
        "choice": choice,
        "page": int(page),
        "xRatio": x,
        "yRatio": y,
        "wRatio": ww,
        "hRatio": hh,
        "source": source,
        "confidence": min(0.92, max(0.55, float(confidence or 0.72))),
    }

def reconcile_sibling_choice_areas(unique, anchors, rows, layout, segment):
    # SOFTM-문항영역 시작: 문제 단위 문항 배열을 기준으로 저장 영역의 sibling 겹침/침범을 최종 보정 - 2026-06-19
    if not unique:
        return {}
    anchor_by_choice = {}
    for anchor in anchors:
        try:
            choice = int(anchor.get("choice") or 0)
        except Exception:
            continue
        if 1 <= choice <= choice_count:
            anchor_by_choice[choice] = anchor

    def anchor_radius(anchor):
        aw = max(0.006, min(0.040, float(anchor.get("wRatio") or 0.012)))
        ah = max(0.006, min(0.040, float(anchor.get("hRatio") or 0.012)))
        return max(aw, ah) * 0.56

    if str(layout) == "grid" and len(rows) == 2:
        raw_row_ys = [median([float(item.get("yRatio") or 0) for item in row], 0.0) for row in rows]
        if len(raw_row_ys) == 2 and abs(raw_row_ys[1] - raw_row_ys[0]) < 0.012:
            center_y = median(raw_row_ys, (float(segment["top"]) + float(segment["bottom"])) * 0.5)
            gap = max(0.018, min(0.040, (float(segment["bottom"]) - float(segment["top"])) * 0.28))
            for row_index, row in enumerate(rows):
                for anchor in row:
                    anchor["_layoutSolvedY"] = clamp(center_y + (-gap * 0.5 if row_index == 0 else gap * 0.5), segment["top"], segment["bottom"])
            # SOFTM-문항영역: grid 두 행이 같은 픽셀 후보로 붙으면 segment 안에서 위/아래 행을 분리해 중복 영역을 방지 - 2026-06-19

    row_bounds = {}
    for row_index, row in enumerate(rows):
        row = sorted(row, key=lambda item: float(item.get("xRatio") or 0))
        row_y = median([float(item.get("_layoutSolvedY", item.get("yRatio") or 0)) for item in row], 0.0)
        prev_rows = rows[:row_index]
        next_rows = rows[row_index + 1:]
        prev_y = median([float(item.get("_layoutSolvedY", item.get("yRatio") or 0)) for item in prev_rows[-1]], 0.0) if prev_rows else None
        next_y = median([float(item.get("_layoutSolvedY", item.get("yRatio") or 0)) for item in next_rows[0]], 0.0) if next_rows else None
        row_r = median([anchor_radius(item) for item in row], 0.008)
        row_segment_fallback = any(str(item.get("source") or "").lower().startswith("segment-choice-anchor") for item in row)
        if str(layout) == "grid" and row_segment_fallback:
            row_pad = max(0.002, row_r * 0.35)
            top = row_y - max(0.010, row_r * 1.35) if prev_y is None else (prev_y + row_y) * 0.5 + row_pad
            bottom = float(segment["bottom"]) if next_y is None else next_y - max(0.004, row_r * 1.05)
            # SOFTM-문항영역: segment fallback grid는 최종 sibling 보정에서도 이미지/코드 cell 높이를 유지 - 2026-06-19
        else:
            top = row_y - max(0.010, row_r * 1.35) if prev_y is None else (prev_y + row_y) * 0.5 + max(0.0015, row_r * 0.14)
            bottom = row_y + max(0.011, row_r * (3.8 if str(layout) == "vertical" else 1.65)) if next_y is None else (row_y + next_y) * 0.5 - max(0.0015, row_r * 0.14)
        top = clamp(top, segment["top"], segment["bottom"])
        bottom = clamp(bottom, top + 0.006, segment["bottom"])
        for idx, anchor in enumerate(row):
            try:
                choice = int(anchor.get("choice") or 0)
                ax = float(anchor.get("xRatio") or 0)
            except Exception:
                continue
            r = anchor_radius(anchor)
            left_min = clamp(ax + r * 0.62, segment["left"], segment["right"])
            if idx + 1 < len(row):
                next_anchor = row[idx + 1]
                try:
                    nx = float(next_anchor.get("xRatio") or 0)
                    nr = anchor_radius(next_anchor)
                    right_max = min(segment["right"], nx - max(r * 1.10, nr * 0.95))
                except Exception:
                    right_max = segment["right"]
            else:
                right_max = segment["right"]
            row_bounds[choice] = {
                "top": top,
                "bottom": bottom,
                "leftMin": left_min,
                "rightMax": max(left_min + 0.006, right_max),
                "x": ax,
                "y": float(anchor.get("_layoutSolvedY", anchor.get("yRatio") or row_y)),
            }

    repaired = {}
    for choice, area in unique.items():
        bounds = row_bounds.get(int(choice))
        if not bounds:
            continue
        x = clamp(float(area.get("xRatio") or 0), bounds["leftMin"], bounds["rightMax"])
        y = clamp(float(area.get("yRatio") or 0), bounds["top"], bounds["bottom"])
        right = clamp(float(area.get("xRatio") or 0) + float(area.get("wRatio") or 0), x + 0.001, bounds["rightMax"])
        bottom = clamp(float(area.get("yRatio") or 0) + float(area.get("hRatio") or 0), y + 0.001, bounds["bottom"])
        if right - x < 0.004 or bottom - y < 0.004:
            continue
        next_area = dict(area)
        next_area["xRatio"] = x
        next_area["yRatio"] = y
        next_area["wRatio"] = right - x
        next_area["hRatio"] = bottom - y
        repaired[int(choice)] = next_area

    def box(area):
        x1 = float(area.get("xRatio") or 0)
        y1 = float(area.get("yRatio") or 0)
        return x1, y1, x1 + float(area.get("wRatio") or 0), y1 + float(area.get("hRatio") or 0)

    for _ in range(2):
        changed = False
        keys = sorted(repaired)
        for i, a_key in enumerate(keys):
            for b_key in keys[i + 1:]:
                a = repaired.get(a_key)
                b = repaired.get(b_key)
                if not a or not b:
                    continue
                ax1, ay1, ax2, ay2 = box(a)
                bx1, by1, bx2, by2 = box(b)
                iw = max(0.0, min(ax2, bx2) - max(ax1, bx1))
                ih = max(0.0, min(ay2, by2) - max(ay1, by1))
                if iw <= 0 or ih <= 0:
                    continue
                overlap = iw * ih
                small_area = max(0.000001, min((ax2 - ax1) * (ay2 - ay1), (bx2 - bx1) * (by2 - by1)))
                if overlap / small_area < 0.08:
                    continue
                a_anchor = row_bounds.get(a_key, {})
                b_anchor = row_bounds.get(b_key, {})
                same_grid_row = str(layout) == "grid" and ((a_key in (1, 2) and b_key in (1, 2)) or (a_key in (3, 4) and b_key in (3, 4)))
                same_row = same_grid_row or (str(layout) != "grid" and abs(float(a_anchor.get("y", 0)) - float(b_anchor.get("y", 0))) <= max(0.010, min(float(a.get("hRatio") or 0.01), float(b.get("hRatio") or 0.01)) * 0.75))
                if same_row:
                    split = (float(a_anchor.get("x", ax2)) + float(b_anchor.get("x", bx1))) * 0.5
                    if float(a_anchor.get("x", 0)) <= float(b_anchor.get("x", 0)):
                        a["wRatio"] = max(0.001, min(ax2, split) - ax1)
                        b_x = max(bx1, split)
                        b["wRatio"] = max(0.001, bx2 - b_x)
                        b["xRatio"] = b_x
                    else:
                        b["wRatio"] = max(0.001, min(bx2, split) - bx1)
                        a_x = max(ax1, split)
                        a["wRatio"] = max(0.001, ax2 - a_x)
                        a["xRatio"] = a_x
                else:
                    split = (float(a_anchor.get("y", ay2)) + float(b_anchor.get("y", by1))) * 0.5
                    if float(a_anchor.get("y", 0)) <= float(b_anchor.get("y", 0)):
                        a["hRatio"] = max(0.001, min(ay2, split) - ay1)
                        b_y = max(by1, split)
                        b["hRatio"] = max(0.001, by2 - b_y)
                        b["yRatio"] = b_y
                    else:
                        b["hRatio"] = max(0.001, min(by2, split) - by1)
                        a_y = max(ay1, split)
                        a["hRatio"] = max(0.001, ay2 - a_y)
                        a["yRatio"] = a_y
                changed = True
        if not changed:
            break

    return {
        choice: area for choice, area in repaired.items()
        if float(area.get("wRatio") or 0) >= 0.004 and float(area.get("hRatio") or 0) >= 0.004
    }
    # SOFTM-문항영역 끝

out = {}
for q in range(1, question_count + 1):
    anchors = [dict(item) for item in (choice_map.get(str(q)) or []) if isinstance(item, dict)]
    anchors = [item for item in anchors if 1 <= int(item.get("choice") or 0) <= choice_count]
    if not anchors:
        continue
    page = int(anchors[0].get("page") or 0)
    image_path = page_files.get(page)
    if not image_path:
        continue
    im = Image.open(image_path).convert("L")
    arr = np.array(im)
    h, w = arr.shape
    segment = segment_for(q, page, anchors[0])
    if segment["right"] <= segment["left"] or segment["bottom"] <= segment["top"]:
        continue
    anchors = [
        item for item in anchors
        if segment["left"] - 0.002 <= float(item.get("xRatio") or -1) <= segment["right"] + 0.002
        and segment["top"] - 0.001 <= float(item.get("yRatio") or -1) <= segment["bottom"] + 0.0005
    ]
    if not anchors:
        continue
    # SOFTM-문항영역: 위치맵 저장 영역도 문제~다음 문제 hard boundary 안의 문항앵커로만 생성 - 2026-06-17
    rows = rows_for(anchors)
    row_ys = [median([float(anchor.get("yRatio") or 0) for anchor in row], 0.0) for row in rows]
    row_pad = max(0.012, min(0.026, median([float(anchor.get("hRatio") or 0.012) for anchor in anchors], 0.012) * 1.55))
    row_gaps = [row_ys[idx + 1] - row_ys[idx] for idx in range(len(row_ys) - 1) if row_ys[idx + 1] > row_ys[idx]]
    row_gap = median(row_gaps, row_pad * 3.2)
    layout = layout_for(anchors)
    segment_fallback_layout = any(str(anchor.get("source") or "").lower().startswith("segment-choice-anchor") for anchor in anchors)
    segment_bullet_layout = any("segment-bullet" in str(anchor.get("source") or "").lower() for anchor in anchors)
    expanded = layout in ("vertical", "grid") or len(rows) > 1
    vertical_text_layout = layout == "vertical"
    if segment_fallback_layout:
        # SOFTM-문항영역: segment 기반 보수 앵커는 실제 텍스트 후보가 약하므로 grid 행끼리 겹치지 않게 행 경계를 보수적으로 제한 - 2026-06-17
        separator_pad = max(0.004, min(0.008, row_gap * 0.18)) if layout == "grid" else max(0.005, min(0.010, row_gap * 0.34))
        tail_reach = max(0.010, min(0.018, row_gap * 0.56)) if layout == "grid" else max(0.016, min(0.040, row_gap * 1.18))
    elif segment_bullet_layout and vertical_text_layout:
        # SOFTM-문항영역: 57번 같은 촘촘한 특수 불렛 세로 보기는 마지막 행이 다음 문제 문장까지 확장되지 않게 짧은 행 높이로 제한 - 2026-06-17
        separator_pad = max(0.003, min(0.008, row_gap * 0.24))
        tail_reach = max(0.018, min(0.026, row_gap * 1.40))
    elif vertical_text_layout:
        # SOFTM-문항영역: 세로형 긴 선택지는 다음 보기 직전까지 픽셀 탐색해 2줄 이상 텍스트를 포함 - 2026-06-17
        separator_pad = max(0.006, min(0.014, row_gap * 0.30))
        tail_reach = max(row_pad * 2.2, min(0.085, max(0.038, row_gap * 1.34)))
        # SOFTM-문항영역: 세로형 긴 보기 스캔은 유지하되 다음 보기 원/텍스트가 섞일 만큼 행 하단을 과확장하지 않음 - 2026-06-19
    else:
        separator_pad = max(row_pad, min(0.030, row_gap * 0.36))
        tail_reach = max(row_pad * 2.4, min(0.085, row_gap * 0.82))
    areas = []
    for row_index, row in enumerate(rows):
        row_y = row_ys[row_index]
        next_y = row_ys[row_index + 1] if row_index + 1 < len(row_ys) else None
        prev_y = row_ys[row_index - 1] if row_index > 0 else None
        if expanded:
            row_top_ratio = row_y - separator_pad
            row_bottom_ratio = min(segment["bottom"], row_y + tail_reach) if next_y is None else next_y - separator_pad
            if layout == "grid":
                # SOFTM-문항영역: 촘촘한 2행 grid는 위/아래 행 중간선을 넘지 않아 sibling 영역과 겹치지 않게 자른다 - 2026-06-17
                if prev_y is not None:
                    row_top_ratio = max(row_top_ratio, (prev_y + row_y) * 0.5 + separator_pad * 0.25)
                if next_y is not None:
                    row_bottom_ratio = min(row_bottom_ratio, (row_y + next_y) * 0.5 - separator_pad * 0.25)
        else:
            row_top_ratio = row_y - row_pad if prev_y is None else (prev_y + row_y) * 0.5
            row_bottom_ratio = row_y + row_pad if next_y is None else (row_y + next_y) * 0.5
        row_top_ratio = clamp(row_top_ratio, segment["top"], segment["bottom"])
        min_row_bottom = row_y + (min(row_pad, row_gap * 0.40) if layout == "grid" else row_pad) # SOFTM-문항영역: grid 최소 높이가 행 중간선을 넘겨 sibling과 겹치지 않게 제한 - 2026-06-17
        if next_y is not None and (segment_fallback_layout or segment_bullet_layout or vertical_text_layout):
            min_row_bottom = min(min_row_bottom, next_y - max(0.002, separator_pad * 0.50)) # SOFTM-문항영역: 세로형/특수 불렛 영역 최소 높이 보정이 다음 보기 경계를 넘지 않게 제한 - 2026-06-17
        row_bottom_ratio = clamp(max(row_bottom_ratio, min_row_bottom), segment["top"], segment["bottom"])
        if row_bottom_ratio <= row_top_ratio + 0.004:
            continue
        row_top = row_top_ratio * h
        row_bottom = row_bottom_ratio * h
        column_left = segment["left"] * w
        column_right = segment["right"] * w
        gutter = max(18, w * 0.018) if (segment["right"] - segment["left"]) < 0.86 else 0
        row_right_limit = max(column_left + 24, column_right - gutter)
        for idx, anchor in enumerate(row):
            choice = int(anchor.get("choice") or 0)
            if choice < 1 or choice > choice_count:
                continue
            ax = float(anchor.get("xRatio") or 0) * w
            ay = float(anchor.get("yRatio") or 0) * h
            aw = max(10.0, min(42.0, float(anchor.get("wRatio") or 0.012) * w))
            ah = max(10.0, min(42.0, float(anchor.get("hRatio") or 0.012) * h))
            r = max(6.0, min(32.0, max(aw, ah) * 0.56))
            anchor_source = str(anchor.get("source") or "").lower()
            is_segment_fallback_anchor = anchor_source.startswith("segment-choice-anchor") # SOFTM-문항영역: segment 기반 보수 앵커 source는 suffix가 붙어도 같은 스캔 보정으로 처리 - 2026-06-17
            start_x = clamp(ax + r * (0.58 if is_segment_fallback_anchor else 1.08), column_left, row_right_limit)
            prev_anchor = row[idx - 1] if idx > 0 else None
            next_anchor = row[idx + 1] if idx + 1 < len(row) else None
            if next_anchor is not None:
                next_x = float(next_anchor.get("xRatio") or 0) * w
                next_w = max(10.0, min(42.0, float(next_anchor.get("wRatio") or 0.012) * w))
                fallback_right = min(row_right_limit, next_x - max(r * 1.18, next_w * 1.05))
            else:
                fallback_right = row_right_limit
            if fallback_right <= start_x + 18:
                continue
            base_top = max(row_top, ay - r * 0.9)
            base_bottom = min(row_bottom, ay + r * 0.9)
            scan_top = base_top
            if expanded and layout == "vertical" and len(row) == 1:
                scan_bottom = row_bottom  # SOFTM-문항영역: 세로형 2줄 이상 선택지는 행 하단 전체를 스캔 - 2026-06-17
            else:
                scan_bottom = min(row_bottom, ay + (r * (3.1 if expanded and len(row) == 1 else 4.8 if expanded and len(row) > 1 else 1.9 if expanded else 0.9))) # SOFTM-문항영역: 2열/그리드 선택지의 두 줄 텍스트도 행 경계 안에서 픽셀 탐색 - 2026-06-17
            text = find_text_bounds(arr, start_x, scan_top, fallback_right, scan_bottom)
            confidence = float(anchor.get("confidence") or 0.72)
            structural_grid_area = None
            structural_grid_is_visual = False
            tall_grid_cell = layout == "grid" and (row_bottom - row_top) > max(70.0, r * 7.2)
            if layout == "grid" and (is_segment_fallback_anchor or tall_grid_cell):
                # SOFTM-문항영역: 이미지/코드형 grid는 텍스트 조각 대신 cell 구조로 전체 선택지 클릭 영역을 만든다 - 2026-06-19
                neighbor_gap = None
                if next_anchor is not None:
                    neighbor_gap = (float(next_anchor.get("xRatio") or 0) * w) - ax
                elif prev_anchor is not None:
                    neighbor_gap = ax - (float(prev_anchor.get("xRatio") or 0) * w)
                if neighbor_gap is not None and math.isfinite(neighbor_gap) and neighbor_gap > r * 4:
                    structural_right = min(fallback_right, start_x + max(r * 6.0, neighbor_gap * 0.62))
                else:
                    structural_right = min(fallback_right, start_x + max(r * 8.0, (column_right - column_left) * 0.34))
                structural_top = row_top
                structural_bottom = row_bottom
                if structural_right > start_x + 16 and structural_bottom > structural_top + 10:
                    if is_segment_fallback_anchor or tall_grid_cell:
                        structural_top = max(segment["top"] * h, ay - max(8.0, r * 1.10))
                        if next_y is not None:
                            structural_bottom = min(segment["bottom"] * h, (next_y * h) - max(8.0, r * 1.00))
                        else:
                            structural_bottom = segment["bottom"] * h
                        # SOFTM-문항영역: 이미지/코드형 grid는 행 중간선이 아니라 다음 행 직전/segment 하단까지 클릭 영역을 확장 - 2026-06-19
                    structural_grid_area = (start_x, structural_top, structural_right, structural_bottom)
                    structural_grid_is_visual = looks_like_visual_choice_cell(arr, start_x, structural_top, structural_right, structural_bottom)
            max_text_gap = max(18.0, r * 2.25) if len(row) > 1 else max(24.0, r * 3.4)
            if is_segment_fallback_anchor:
                max_text_gap = max(max_text_gap, min(max(80.0, r * 12.0), (fallback_right - start_x) * 0.46))
            if text and text["x"] - start_x > max_text_gap:
                text = None
            prefer_structural_grid_area = False
            if structural_grid_area and layout == "grid" and structural_grid_is_visual:
                prefer_structural_grid_area = True
                # SOFTM-문항영역: 프레임이 확인된 이미지/구조형 grid 선택지만 내부 텍스트 조각보다 cell 구조 영역을 우선 - 2026-06-19
            if prefer_structural_grid_area:
                left, top, right, bottom = structural_grid_area
                source = "generated-click-area-anchor-text" # SOFTM-문항영역: grid cell fallback은 텍스트 픽셀을 못 찾은 이미지형 선택지에만 적용 - 2026-06-18
            elif text:
                margin_x = max(9.0, min(26.0, r * 0.68))
                margin_y = max(6.0, min(18.0, r * 0.42))
                text_height = float(text.get("h") or 0)
                if layout == "vertical" and next_y is None:
                    vertical_text_limit = min(row_bottom - row_top, r * 4.4)
                else:
                    vertical_text_limit = min(row_bottom - row_top, max(r * 7.2, (row_gap * h) * 1.10))
                # SOFTM-문항영역: 중간 세로 보기는 실제 2줄을 허용하고 마지막 보기는 워터마크 과확장을 더 엄격히 차단 - 2026-06-19
                text_height_reasonable = layout != "vertical" or text_height <= vertical_text_limit
                height_expands_for_text = expanded and (layout == "vertical" or len(row) > 1) and int(text.get("lineCount") or 1) >= 2 and text_height_reasonable
                # SOFTM-문항영역: 세로형/그리드 모두 단일 줄이면 앵커 원 높이를 유지하고 실제 텍스트 행이 합리적일 때만 높이 확장 - 2026-06-19
                bottom_margin = max(margin_y, min(22.0, r * 0.56)) if height_expands_for_text else margin_y
                left = start_x # SOFTM-문항영역: 영역 왼쪽은 텍스트 픽셀이 아니라 문항 앵커 원 오른쪽에 바짝 붙여 시작 - 2026-06-17
                right = min(fallback_right, text["x"] + text["w"] + margin_x)
                if structural_grid_area and is_segment_fallback_anchor and layout == "grid":
                    right = min(right, structural_grid_area[2]) # SOFTM-문항영역: grid 텍스트 탐색이 워터마크를 포함해도 같은 cell 폭 상한을 넘지 않게 제한 - 2026-06-18
                if height_expands_for_text:
                    top = max(row_top, min(base_top, text["y"] - margin_y))
                    text_bottom = text["y"] + text["h"] + bottom_margin
                    if layout == "vertical" and next_y is not None:
                        text_bottom = min(text_bottom, (next_y * h) - max(r * 1.12, margin_y * 1.35))
                    bottom = min(row_bottom, max(base_bottom, text_bottom))
                    # SOFTM-문항영역: 여러 줄 세로 보기라도 실제 텍스트 하단과 다음 보기 원 전까지만 높이를 확장 - 2026-06-19
                else:
                    top = base_top
                    bottom = base_bottom
                if layout == "vertical" and next_y is not None and (next_y - row_y) > max(0.044, row_gap * 1.42) and (right - left) > max(180.0, (column_right - column_left) * 0.45):
                    bottom = min(row_bottom, max(bottom, (next_y * h) - max(r * 1.10, margin_y * 1.35)))
                    # SOFTM-문항영역: lineCount가 1로 잡힌 긴 세로형 보기라도 다음 보기까지 큰 간격이 있으면 2줄 선택지 하단까지 포함 - 2026-06-19
                min_width = max(28.0, r * 3.2)
                right = min(fallback_right, max(right, left + min_width))
                source = "generated-click-area-anchor-text"
            else:
                continue
            if right - left < 16 or bottom - top < 10:
                continue
            area = make_area(q, choice, page, {"x": left, "y": top, "w": right - left, "h": bottom - top}, source, confidence)
            if area:
                areas.append(area)
    if not areas and segment_fallback_layout and layout in ("horizontal", "grid") and len(anchors) >= choice_count:
        # SOFTM-문항영역 시작: 짧은 grid/horizontal 보기의 텍스트 픽셀이 모두 실패하면 문항앵커 원과 같은 행 sibling 경계 기준으로 최소 클릭 영역 생성 - 2026-06-19
        fallback_rows = rows_for(anchors)
        for row in fallback_rows:
            ordered_anchors = sorted(row, key=lambda item: float(item.get("xRatio") or 0))
            for idx, anchor in enumerate(ordered_anchors):
                choice = int(anchor.get("choice") or 0)
                if choice < 1 or choice > choice_count:
                    continue
                ax = float(anchor.get("xRatio") or 0)
                ay = float(anchor.get("yRatio") or 0)
                aw = max(0.010, min(0.040, float(anchor.get("wRatio") or 0.012)))
                ah = max(0.010, min(0.040, float(anchor.get("hRatio") or 0.012)))
                r_ratio = max(aw, ah) * 0.56
                left = clamp(ax + r_ratio * 1.02, segment["left"], segment["right"])
                next_anchor = ordered_anchors[idx + 1] if idx + 1 < len(ordered_anchors) else None
                next_x = float(next_anchor.get("xRatio") or 0) if next_anchor is not None else segment["right"]
                cell_width = max(0.001, next_x - left - max(0.016, r_ratio * 2.2))
                width_ratio = min(max(0.055, r_ratio * 8.0), 0.155, cell_width, max(0.001, segment["right"] - left))
                top = clamp(ay - r_ratio * 0.9, segment["top"], segment["bottom"])
                height_ratio = min(max(0.010, r_ratio * 1.8), max(0.001, segment["bottom"] - top))
                area = make_area(q, choice, page, {
                    "x": left * w,
                    "y": top * h,
                    "w": width_ratio * w,
                    "h": height_ratio * h,
                }, "generated-click-area-anchor-text", float(anchor.get("confidence") or 0.60) * 0.90)
                if area:
                    areas.append(area)
        # SOFTM-문항영역 끝
    if areas or anchors:
        unique = {}
        for area in areas:
            unique[int(area["choice"])] = area
        # SOFTM-문항영역 시작: 일부 보기의 텍스트 픽셀 탐색이 워터마크/저품질로 실패하면 같은 문항의 기존 영역 폭으로 보수 보완 - 2026-06-17
        if layout in ("vertical", "horizontal", "grid") and len(anchors) >= choice_count and 0 < len(unique) < choice_count:
            existing_widths = [float(area.get("wRatio") or 0) for area in unique.values() if float(area.get("wRatio") or 0) > 0]
            existing_heights = [float(area.get("hRatio") or 0) for area in unique.values() if float(area.get("hRatio") or 0) > 0]
            fallback_width = median(existing_widths, 0.42)
            fallback_height = median(existing_heights, 0.018)
            for anchor in anchors:
                choice = int(anchor.get("choice") or 0)
                if choice < 1 or choice > choice_count or choice in unique:
                    continue
                ax = float(anchor.get("xRatio") or 0)
                ay = float(anchor.get("yRatio") or 0)
                aw = max(0.010, min(0.040, float(anchor.get("wRatio") or 0.012)))
                ah = max(0.010, min(0.040, float(anchor.get("hRatio") or 0.012)))
                r_ratio = max(aw, ah) * 0.56
                left = clamp(ax + r_ratio * 1.08, segment["left"], segment["right"])
                width_ratio = min(max(0.030, fallback_width), max(0.001, segment["right"] - left))
                top = clamp(ay - fallback_height * 0.5, segment["top"], segment["bottom"])
                height_ratio = min(max(0.010, fallback_height), max(0.001, segment["bottom"] - top))
                fallback_area = make_area(q, choice, page, {
                    "x": left * w,
                    "y": top * h,
                    "w": width_ratio * w,
                    "h": height_ratio * h,
                }, "generated-click-area-anchor-text", float(anchor.get("confidence") or 0.60) * 0.92)
                if fallback_area:
                    unique[choice] = fallback_area
        # SOFTM-문항영역 끝
        # SOFTM-문항영역 시작: 한 줄 보기에서 한 선택지만 다음 보기 직전까지 과확장되면 형제 보기 폭 기준으로 줄임 - 2026-06-17
        if layout == "horizontal" and len(unique) >= 3:
            widths = sorted([float(area.get("wRatio") or 0) for area in unique.values() if float(area.get("wRatio") or 0) > 0])
            width_mid = widths[len(widths) // 2] if widths else 0
            if segment_fallback_layout and width_mid > 0.130:
                cap_width = 0.135 # SOFTM-문항영역: segment 기반 한 줄 fallback은 워터마크가 텍스트처럼 잡혀도 다음 앵커 직전까지 과확장하지 않도록 제한 - 2026-06-17
                for area in unique.values():
                    if float(area.get("wRatio") or 0) > cap_width:
                        area["wRatio"] = max(0.001, min(cap_width, 1.0 - float(area.get("xRatio") or 0)))
            elif 0.010 <= width_mid <= 0.120:
                cap_width = min(0.180, width_mid * 1.38)
                for area in unique.values():
                    if float(area.get("wRatio") or 0) > max(cap_width, width_mid * 2.20):
                        area["wRatio"] = max(0.001, min(cap_width, 1.0 - float(area.get("xRatio") or 0)))
        # SOFTM-문항영역 끝
        unique = reconcile_sibling_choice_areas(unique, anchors, rows, layout, segment) # SOFTM-문항영역: 저장 직전 1~4 문항을 배열 단위로 보정 - 2026-06-19
        if len(unique) < choice_count and len(anchors) >= choice_count:
            # SOFTM-문항영역 시작: 텍스트 픽셀 탐색 실패 문항도 sibling 배열 경계 안에서 최소 anchor-band 영역으로 보완 - 2026-06-19
            for row in rows:
                ordered_anchors = sorted(row, key=lambda item: float(item.get("xRatio") or 0))
                for idx, anchor in enumerate(ordered_anchors):
                    choice = int(anchor.get("choice") or 0)
                    if choice < 1 or choice > choice_count or choice in unique:
                        continue
                    ax = float(anchor.get("xRatio") or 0)
                    ay = float(anchor.get("_layoutSolvedY", anchor.get("yRatio") or 0))
                    aw = max(0.010, min(0.040, float(anchor.get("wRatio") or 0.012)))
                    ah = max(0.010, min(0.040, float(anchor.get("hRatio") or 0.012)))
                    r_ratio = max(aw, ah) * 0.56
                    left = clamp(ax + r_ratio * 0.92, segment["left"], segment["right"])
                    next_anchor = ordered_anchors[idx + 1] if idx + 1 < len(ordered_anchors) else None
                    next_x = float(next_anchor.get("xRatio") or 0) if next_anchor is not None else segment["right"]
                    cell_width = max(0.001, next_x - left - max(0.014, r_ratio * 2.0))
                    width_ratio = min(max(0.052, r_ratio * 7.4), 0.142, cell_width, max(0.001, segment["right"] - left))
                    top = clamp(ay - r_ratio * 0.9, segment["top"], segment["bottom"])
                    height_ratio = min(max(0.006, r_ratio * 1.8), max(0.001, segment["bottom"] - top))
                    fallback_area = make_area(q, choice, page, {
                        "x": left * w,
                        "y": top * h,
                        "w": width_ratio * w,
                        "h": height_ratio * h,
                    }, "generated-click-area-anchor-text", float(anchor.get("confidence") or 0.58) * 0.88)
                    if fallback_area:
                        unique[choice] = fallback_area
            unique = reconcile_sibling_choice_areas(unique, anchors, rows, layout, segment)
            # SOFTM-문항영역 끝
        if len(unique) < choice_count and len(anchors) >= choice_count:
            # SOFTM-문항영역 시작: 최종 reconcile 후 삭제된 누락 문항은 앵커 원 높이 기준 최소 영역으로 다시 채움 - 2026-06-19
            for row in rows:
                ordered_anchors = sorted(row, key=lambda item: float(item.get("xRatio") or 0))
                for idx, anchor in enumerate(ordered_anchors):
                    choice = int(anchor.get("choice") or 0)
                    if choice < 1 or choice > choice_count or choice in unique:
                        continue
                    ax = float(anchor.get("xRatio") or 0)
                    ay = float(anchor.get("_layoutSolvedY", anchor.get("yRatio") or 0))
                    aw = max(0.010, min(0.040, float(anchor.get("wRatio") or 0.012)))
                    ah = max(0.010, min(0.040, float(anchor.get("hRatio") or 0.012)))
                    r_ratio = max(aw, ah) * 0.56
                    left = clamp(ax + r_ratio * 0.92, segment["left"], segment["right"])
                    next_anchor = ordered_anchors[idx + 1] if idx + 1 < len(ordered_anchors) else None
                    next_x = float(next_anchor.get("xRatio") or 0) if next_anchor is not None else segment["right"]
                    width_ratio = min(max(0.052, r_ratio * 7.4), 0.142, max(0.001, next_x - left - max(0.014, r_ratio * 2.0)), max(0.001, segment["right"] - left))
                    top = clamp(ay - r_ratio * 0.9, segment["top"], segment["bottom"])
                    height_ratio = min(max(0.006, r_ratio * 1.8), max(0.001, segment["bottom"] - top))
                    fallback_area = make_area(q, choice, page, {
                        "x": left * w,
                        "y": top * h,
                        "w": width_ratio * w,
                        "h": height_ratio * h,
                    }, "generated-click-area-anchor-text", float(anchor.get("confidence") or 0.58) * 0.84)
                    if fallback_area:
                        unique[choice] = fallback_area
            # SOFTM-문항영역 끝
        if not unique:
            continue
        out[str(q)] = [unique[key] for key in sorted(unique)]

print(json.dumps(out, ensure_ascii=False))
`;
  const result = await run("python3", ["-c", script, pageDir, mapPath], { maxBuffer: 40 * 1024 * 1024 });
  return JSON.parse(result.stdout || "{}");
}
/* SOFTM-문항영역 끝 */

function completeTrailingChoiceMap(choiceMap, questionSegments, questionCount, choiceCount){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (
      choiceCount === 4
      && anchors.length === 3
      && anchors.every((item, idx) => Number(item.choice) === idx + 1)
      && anchors.every((item) => String(item.layout || "") === "vertical")
    ) {
      const ys = anchors.map((item) => Number(item.yRatio)).filter(Number.isFinite);
      const xs = anchors.map((item) => Number(item.xRatio)).filter(Number.isFinite);
      const gaps = ys.slice(1).map((value, idx) => value - ys[idx]).filter((value) => value > 0);
      const medianGap = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 0;
      const inferredY = ys.at(-1) + medianGap;
      const segment = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)][0] : null;
      const segmentBottom = Number(segment?.bottom);
      const segmentLeft = Number.isFinite(Number(segment?.left)) ? Number(segment.left) : 0;
      const segmentRight = Number.isFinite(Number(segment?.right)) ? Number(segment.right) : 1;
      const segmentTop = Number(segment?.top);
      const segmentHeight = Number.isFinite(segmentBottom) && Number.isFinite(segmentTop) ? segmentBottom - segmentTop : NaN;
      const segmentWidth = segmentRight - segmentLeft;
      const shouldSkipVerticalTrailing = Number.isFinite(segmentHeight) && Number.isFinite(segmentWidth) && segmentWidth < 0.70 && segmentHeight <= 0.105; // SOFTM-문항앵커: 짧은 2열 문항은 세로 ④ 추정 대신 grid fallback으로 처리 - 2026-06-17
      if (shouldSkipVerticalTrailing) {
        const page = Number(anchors[0]?.page);
        const xLeft = clampGeneratedRatio(segmentLeft + segmentWidth * 0.095, segmentLeft + segmentWidth * 0.055, segmentRight - segmentWidth * 0.58);
        const xRight = clampGeneratedRatio(segmentLeft + segmentWidth * 0.522, segmentLeft + segmentWidth * 0.36, segmentRight - segmentWidth * 0.10);
        const yTop = clampGeneratedRatio(segmentTop + segmentHeight * 0.620, segmentTop + segmentHeight * 0.50, segmentBottom - segmentHeight * 0.24);
        const yBottom = clampGeneratedRatio(segmentTop + segmentHeight * 0.835, yTop + Math.max(0.018, segmentHeight * 0.16), segmentBottom - 0.006);
        anchors.splice(0, anchors.length, ...[
          { choice: 1, page, xRatio: xLeft, yRatio: yTop },
          { choice: 2, page, xRatio: xRight, yRatio: yTop },
          { choice: 3, page, xRatio: xLeft, yRatio: yBottom },
          { choice: 4, page, xRatio: xRight, yRatio: yBottom },
        ].map((item) => ({
          ...anchors[0],
          ...item,
          wRatio: Math.max(0.010, Math.min(0.022, segmentWidth * 0.018)),
          hRatio: 0.012,
          source: "segment-choice-anchor-text-grid",
          anchorMode: "center",
          layout: "grid",
          confidence: 0.55,
          inferred: true,
        })));
      }
      const tailBottom = Number.isFinite(segmentBottom) ? segmentBottom : 0.965;
      const bottomTolerance = tailBottom >= 0.940 ? 0.014 : 0; // SOFTM-문항앵커: 페이지/단 하단에서 ④만 빠진 세로 보기는 segment 끝 근처까지 복원 허용 - 2026-06-17
      if (
        !shouldSkipVerticalTrailing
        && gaps.length >= 2
        && medianGap >= 0.010
        && medianGap <= 0.060
        && Number.isFinite(inferredY)
        && inferredY > ys.at(-1) + 0.008
        && inferredY <= Math.min(0.972, tailBottom + bottomTolerance)
      ) {
        const base = anchors.at(-1);
        anchors.push({
          ...base,
          choice: 4,
          xRatio: xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : base.xRatio,
          yRatio: Math.min(inferredY, Math.max(ys.at(-1) + 0.008, tailBottom + Math.min(0.004, bottomTolerance * 0.35))),
          source: `${base.source || "anchor-image"}-post-inferred-trailing`,
          inferred: true,
          confidence: Math.min(0.62, Number(base.confidence || 0.62)),
        });
      }
    }
    if (anchors.length) out[String(q)] = anchors.sort((a, b) => Number(a.choice) - Number(b.choice));
  }
  return out;
}
// SOFTM-위치맵: 세로형 ①②③이 확실하고 ④만 약하게 빠진 경우에도 현재 문제 segment 안에서만 마지막 보기를 복원 - 2026-06-17

function repairLeadingVerticalChoiceMap(choiceMap, questionSegments, questionLabelMap, questionCount, choiceCount){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (!anchors.length) continue;
    if (choiceCount !== 4 || anchors.length < 3) {
      out[String(q)] = anchors;
      continue;
    }
    const ordered = anchors
      .filter((item) => Number.isInteger(Number(item.choice)) && Number(item.choice) >= 1 && Number(item.choice) <= choiceCount)
      .sort((a, b) => Number(a.choice) - Number(b.choice));
    const vertical = ordered.length >= 3 && ordered.every((item) => String(item.layout || "") === "vertical");
    const hasTrailingSignal = ordered.length < choiceCount || ordered.some((item) => String(item.source || "").includes("post-inferred-trailing"));
    if (!vertical || !hasTrailingSignal) {
      out[String(q)] = anchors;
      continue;
    }
    const page = Number(ordered[0]?.page);
    if (!Number.isFinite(page) || ordered.some((item) => Number(item.page) !== page)) {
      out[String(q)] = anchors;
      continue;
    }
    const ys = ordered.map((item) => Number(item.yRatio)).filter(Number.isFinite);
    const xs = ordered.map((item) => Number(item.xRatio)).filter(Number.isFinite);
    if (ys.length !== ordered.length || xs.length !== ordered.length || Math.max(...xs) - Math.min(...xs) > 0.060) {
      out[String(q)] = anchors;
      continue;
    }
    const gaps = ys.slice(1).map((value, idx) => value - ys[idx]).filter((value) => Number.isFinite(value) && value > 0);
    if (gaps.length < 2) {
      out[String(q)] = anchors;
      continue;
    }
    const sortedGaps = gaps.slice().sort((a, b) => a - b);
    const gap = ordered.length < choiceCount && gaps.length === 2 ? Math.max(...gaps) : sortedGaps[Math.floor(sortedGaps.length / 2)];
    const relaxedMissingTail = ordered.length < choiceCount && gaps.length === 2; // SOFTM-위치맵: ①/②가 여러 줄인 3개 감지 세로형은 행 간격이 불균일해도 큰 간격으로 선두 누락을 복원 - 2026-06-17
    if (
      !Number.isFinite(gap)
      || gap < 0.018
      || gap > 0.075
      || (!relaxedMissingTail && gaps.some((value) => Math.abs(value - gap) > Math.max(0.012, gap * 0.42)))
    ) {
      out[String(q)] = anchors;
      continue;
    }
    const label = questionLabelMap?.[String(q)] || {};
    const labelY = Number(label.yRatio);
    if (Number(label.page) !== page || !Number.isFinite(labelY)) {
      out[String(q)] = anchors;
      continue;
    }
    const inferredY = ys[0] - gap;
    const segments = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : [];
    const segment = segments.find((item) => Number(item.page) === page) || segments[0] || null;
    const segmentTop = Number.isFinite(Number(segment?.top)) ? Number(segment.top) : 0;
    const segmentBottom = Number.isFinite(Number(segment?.bottom)) ? Number(segment.bottom) : 1;
    if (
      inferredY <= labelY + 0.018
      || ys[0] - labelY < gap * 1.30 + 0.012
      || inferredY < segmentTop - 0.006
      || inferredY > segmentBottom + 0.006
    ) {
      out[String(q)] = anchors;
      continue;
    }
    const base = ordered[0];
    const leading = {
      ...base,
      choice: 1,
      yRatio: Math.max(segmentTop, inferredY),
      source: `${base.source || "anchor-image"}-post-inferred-leading`,
      inferred: true,
      confidence: Math.min(0.62, Number(base.confidence || 0.62)),
    };
    const repaired = [leading];
    for (let idx = 0; idx < Math.min(choiceCount - 1, ordered.length); idx += 1){
      const shifted = {
        ...ordered[idx],
        choice: idx + 2,
        source: `${ordered[idx].source || "anchor-image"}-post-shifted-leading`,
      };
      repaired.push(shifted);
    }
    out[String(q)] = repaired.sort((a, b) => Number(a.choice) - Number(b.choice));
  }
  return out;
}
// SOFTM-위치맵: 세로형 보기에서 ① 행이 빠지고 ②~④가 ①~③으로 밀린 경우 문제 라벨과 행 간격으로 선두 보기를 복원 - 2026-06-17

function repairCollapsedLowerGridChoiceMap(choiceMap, questionSegments, questionCount, choiceCount){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (choiceCount !== 4 || anchors.length !== 4) {
      if (anchors.length) out[String(q)] = anchors;
      continue;
    }
    const ordered = anchors
      .filter((item) => Number.isInteger(Number(item.choice)) && Number(item.choice) >= 1 && Number(item.choice) <= 4)
      .sort((a, b) => Number(a.choice) - Number(b.choice));
    if (ordered.length !== 4 || !ordered.every((item) => String(item.layout || "") === "horizontal")) {
      out[String(q)] = anchors;
      continue;
    }
    const page = Number(ordered[0].page);
    const ys = ordered.map((item) => Number(item.yRatio));
    const xs = ordered.map((item) => Number(item.xRatio));
    if (!Number.isFinite(page) || ys.some((value) => !Number.isFinite(value)) || xs.some((value) => !Number.isFinite(value))) {
      out[String(q)] = anchors;
      continue;
    }
    if (Math.max(...ys) - Math.min(...ys) > 0.018 || Math.abs(xs[0] - 0.095) > 0.035 || Math.abs(xs[2] - 0.522) > 0.050) {
      out[String(q)] = anchors;
      continue;
    }
    const segments = Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : [];
    const segment = segments.find((item) => Number(item.page) === page) || segments[0] || null;
    const top = Number(segment?.top);
    const bottom = Number(segment?.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
      out[String(q)] = anchors;
      continue;
    }
    const height = bottom - top;
    const rowY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const sourceText = ordered.map((item) => String(item.source || "")).join(" ");
    const looksLikeRescue = sourceText.includes("short-rescue") || sourceText.includes("expected-x");
    if (!looksLikeRescue || height < 0.085 || height > 0.170 || rowY - top < Math.max(0.052, height * 0.44)) {
      out[String(q)] = anchors;
      continue;
    }
    const gap = Math.max(0.028, Math.min(0.045, (rowY - top) * 0.46));
    const topY = Math.max(top + 0.028, rowY - gap);
    if (topY >= rowY - 0.014) {
      out[String(q)] = anchors;
      continue;
    }
    const bottomLeft = { ...ordered[0], choice: 3, layout: "grid", source: `${ordered[0].source || "anchor-image"}-lower-grid` };
    const bottomRight = { ...ordered[2], choice: 4, layout: "grid", source: `${ordered[2].source || "anchor-image"}-lower-grid` };
    const topLeft = {
      ...ordered[0],
      choice: 1,
      yRatio: topY,
      layout: "grid",
      source: `${ordered[0].source || "anchor-image"}-inferred-upper-grid`,
      inferred: true,
      confidence: Math.min(0.68, Number(ordered[0].confidence) || 0.62),
    };
    const topRight = {
      ...ordered[2],
      choice: 2,
      yRatio: topY,
      layout: "grid",
      source: `${ordered[2].source || "anchor-image"}-inferred-upper-grid`,
      inferred: true,
      confidence: Math.min(0.68, Number(ordered[2].confidence) || 0.62),
    };
    out[String(q)] = [topLeft, topRight, bottomLeft, bottomRight].sort((a, b) => Number(a.choice) - Number(b.choice));
  }
  return out;
}
// SOFTM-문항앵커: 짧은 segment의 2행 grid 아래 행을 한 줄 horizontal로 접은 결과를 최종 저장 전 grid로 복원 - 2026-06-18

function repairQuestionLineGridChoiceMap(choiceMap, questionSegments, questionLabelMap, questionCount, choiceCount){
  const out = {};
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)].map((item) => ({ ...item })) : [];
    if (choiceCount !== 4 || anchors.length !== 4 || !anchors.every((item) => String(item.layout || "") === "grid")) {
      if (anchors.length) out[String(q)] = anchors;
      continue;
    }
    const page = Number(anchors[0]?.page);
    if (!Number.isFinite(page) || anchors.some((item) => Number(item.page) !== page)) {
      out[String(q)] = anchors;
      continue;
    }
    const segment = (Array.isArray(questionSegments?.[String(q)]) ? questionSegments[String(q)] : []).find((item) => Number(item.page) === page) || null;
    const label = questionLabelMap?.[String(q)] || {};
    const top = Number(segment?.top);
    const bottom = Number(segment?.bottom);
    const left = Number.isFinite(Number(segment?.left)) ? Number(segment.left) : 0;
    const right = Number.isFinite(Number(segment?.right)) ? Number(segment.right) : 1;
    const labelY = Number(label.yRatio);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(labelY) || bottom <= top || right - left < 0.70) {
      out[String(q)] = anchors;
      continue;
    }
    const height = bottom - top;
    const ordered = anchors.slice().sort((a, b) => Number(a.choice) - Number(b.choice));
    const byChoice = new Map(ordered.map((item) => [Number(item.choice), item]));
    const upper = [byChoice.get(1), byChoice.get(2)];
    const lower = [byChoice.get(3), byChoice.get(4)];
    const upperSources = upper.map((item) => String(item?.source || "").toLowerCase());
    const lowerSources = lower.map((item) => String(item?.source || "").toLowerCase());
    const upperY = upper.map((item) => Number(item?.yRatio)).filter(Number.isFinite);
    const lowerY = lower.map((item) => Number(item?.yRatio)).filter(Number.isFinite);
    const inferredUpperGrid = upperY.length === 2
      && lowerY.length === 2
      && upperSources.every((source) => source.includes("inferred-upper-grid"))
      && lowerSources.every((source) => source.includes("short-rescue") || source.includes("lower-grid"));
    if (inferredUpperGrid) {
      const y = clampGeneratedRatio(lowerY.reduce((sum, value) => sum + value, 0) / lowerY.length, top + height * 0.45, bottom - 0.006);
      const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + (right - left) * ratio, left + (right - left) * 0.040, right - (right - left) * 0.040));
      out[String(q)] = xs.map((xRatio, index) => ({
        ...ordered[Math.min(index, ordered.length - 1)],
        choice: index + 1,
        xRatio,
        yRatio: y,
        wRatio: Math.max(0.010, Math.min(0.020, (right - left) * 0.014)),
        hRatio: 0.012,
        source: "segment-choice-anchor-text-horizontal",
        layout: "horizontal",
        anchorMode: "center",
        confidence: Math.max(0.55, Math.min(0.70, Number(lower[index % lower.length]?.confidence) || 0.62)),
        inferred: true,
      }));
      continue;
    }
    // SOFTM-문항앵커: short-rescue가 만든 가짜 upper grid는 실제 lower 보기 행을 한 줄 보기로 복구 - 2026-06-18
    const topRowY = Math.min(...ordered.map((item) => Number(item.yRatio)).filter(Number.isFinite));
    const lowerYs = ordered.map((item) => Number(item.yRatio)).filter((value) => Number.isFinite(value) && value > labelY + Math.max(0.018, height * 0.18));
    const firstRowIsQuestionLine = height >= 0.110
      && height <= 0.155
      && Number.isFinite(topRowY)
      && Math.abs(topRowY - labelY) <= Math.max(0.012, height * 0.14)
      && lowerYs.length >= 2; // SOFTM-문항앵커: grid 첫 행이 문제번호 줄이면 보기 행이 아니라 문제문이므로 한 줄 보기로 복구 - 2026-06-18
    if (!firstRowIsQuestionLine) {
      out[String(q)] = anchors;
      continue;
    }
    const y = clampGeneratedRatio(top + height * 0.700, top + height * 0.55, bottom - 0.006);
    const xs = [0.095, 0.310, 0.522, 0.734].map((ratio) => clampGeneratedRatio(left + (right - left) * ratio, left + (right - left) * 0.040, right - (right - left) * 0.040));
    out[String(q)] = xs.map((xRatio, index) => ({
      ...ordered[Math.min(index, ordered.length - 1)],
      choice: index + 1,
      xRatio,
      yRatio: y,
      wRatio: Math.max(0.010, Math.min(0.020, (right - left) * 0.014)),
      hRatio: 0.012,
      source: "segment-choice-anchor-text-horizontal",
      layout: "horizontal",
      anchorMode: "center",
      confidence: Math.max(0.55, Math.min(0.70, Number(ordered[index]?.confidence) || 0.55)),
      inferred: true,
    }));
  }
  return out;
}
// SOFTM-문항앵커: 문제문 줄을 grid 첫 행으로 착각한 전폭 짧은 문항은 실제 하단 한 줄 보기로 복구 - 2026-06-18

function summarizeChoiceAnchorMap(choiceMap, questionCount, choiceCount){
  let detected = 0;
  const missingQuestions = [];
  for (let q = 1; q <= questionCount; q += 1){
    const anchors = choiceMap && Array.isArray(choiceMap[String(q)]) ? choiceMap[String(q)] : [];
    const validChoices = new Set(
      anchors
        .filter((item) => isReliableChoiceAnchor(item, choiceCount))
        .map((item) => Number(item.choice))
    );
    detected += validChoices.size;
    if (validChoices.size < choiceCount) missingQuestions.push(q);
  }
  const expected = questionCount * choiceCount;
  return {
    detected,
    expected,
    coverage: expected ? detected / expected : 0,
    missingQuestions,
  };
}

function validateAnchorConsistency(pageMap, questionSegments, choiceMap, questionCount, choiceCount){
  const diagnostics = {
    missingSegments: [],
    outOfSegmentChoices: [],
    partialChoiceQuestions: [],
    suspiciousChoiceOrder: [],
  };
  const segmentsFor = (q, page) => {
    const segments = questionSegments && Array.isArray(questionSegments[String(q)]) ? questionSegments[String(q)] : [];
    return segments.filter((segment) => Number(segment.page) === Number(page));
  };
  for (let q = 1; q <= questionCount; q += 1){
    const page = Number(pageMap[q]);
    const segments = segmentsFor(q, page);
    if (!segments.length) {
      diagnostics.missingSegments.push(q);
      continue;
    }
    const choices = choiceMap && Array.isArray(choiceMap[String(q)]) ? choiceMap[String(q)] : [];
    const validChoices = choices.filter((item) => isReliableChoiceAnchor(item, choiceCount));
    if (validChoices.length && validChoices.length < choiceCount) diagnostics.partialChoiceQuestions.push(q);
    const sorted = validChoices.slice().sort((a, b) => Number(a.choice) - Number(b.choice));
    for (const item of sorted){
      const x = Number(item.xRatio);
      const y = Number(item.yRatio);
      const inSegment = Number(item.page) === page
        && Number.isFinite(x)
        && Number.isFinite(y)
        && segments.some((segment) => {
          const top = Number(segment.top);
          const bottom = Number(segment.bottom);
          const left = Number(segment.left ?? 0);
          const right = Number(segment.right ?? 1);
          return Number.isFinite(top)
            && Number.isFinite(bottom)
            && y >= top - 0.018
            && y <= bottom + 0.030
            && x >= left - 0.030
            && x <= right + 0.030;
        }); // SOFTM-연속문항: 선택지 검증도 primary/continuation 모든 segment를 유효 영역으로 인정 - 2026-06-17
      if (!inSegment) {
        diagnostics.outOfSegmentChoices.push({ q, choice: Number(item.choice), page: Number(item.page), xRatio: x, yRatio: y });
      }
    }
    for (let i = 1; i < sorted.length; i += 1){
      const prev = sorted[i - 1];
      const current = sorted[i];
      if (Number(current.choice) <= Number(prev.choice)) continue;
      const dy = Number(current.yRatio) - Number(prev.yRatio);
      const dx = Number(current.xRatio) - Number(prev.xRatio);
      if (Math.abs(dy) > 0.18 || (dy < -0.020 && dx < -0.050)) {
        diagnostics.suspiciousChoiceOrder.push(q);
        break;
      }
    }
  }
  diagnostics.missingSegmentCount = diagnostics.missingSegments.length;
  diagnostics.outOfSegmentChoiceCount = diagnostics.outOfSegmentChoices.length;
  diagnostics.partialChoiceQuestionCount = diagnostics.partialChoiceQuestions.length;
  diagnostics.suspiciousChoiceOrderCount = diagnostics.suspiciousChoiceOrder.length;
  return diagnostics;
}
// SOFTM-위치맵: 생성 후 문제 영역과 선택지 앵커의 일관성을 자동 점검해 케이스별 땜질 대신 검증 가능한 파서로 전환 - 2026-06-01

function adjustTopMapByChoiceAnchors(pageMap, topMap, choiceMap, questionCount, choiceCount, questionLabelMap = {}){
  const nextTopMap = Array.isArray(topMap) ? topMap.slice() : [];
  let changed = false;
  for (let q = 1; q < questionCount; q += 1){
    if (!Array.isArray(pageMap) || Number(pageMap[q]) !== Number(pageMap[q + 1])) continue;
    const current = choiceMap && Array.isArray(choiceMap[String(q)]) ? choiceMap[String(q)] : [];
    const valid = current.filter((item) => isReliableChoiceAnchor(item, choiceCount));
    if (valid.length < Math.max(3, Math.min(choiceCount, 3))) continue;
    const maxChoiceY = Math.max(...valid.map((item) => Number(item.yRatio)).filter(Number.isFinite));
    const nextTop = Number(nextTopMap[q + 1]);
    if (!Number.isFinite(maxChoiceY) || !Number.isFinite(nextTop)) continue;
    const nextLabel = questionLabelMap[String(q + 1)];
    if (
      nextLabel &&
      Number(nextLabel.page) === Number(pageMap[q]) &&
      Number.isFinite(Number(nextLabel.yRatio)) &&
      Number(nextLabel.yRatio) <= maxChoiceY + 0.045
    ) {
      continue;
    }
    if (nextTop <= maxChoiceY + 0.012) {
      nextTopMap[q + 1] = Math.min(0.92, Math.max(nextTop, maxChoiceY + 0.022));
      changed = true;
    }
  }
  return { changed, topMap: nextTopMap };
}
// SOFTM-위치맵: 선택지 좌표는 실제 이미지에서 검출된 값만 저장하고 기하 추정/채움 좌표는 신뢰 앵커에서 제외 - 2026-05-30
// SOFTM-위치맵: 그리드 실패 시 세로형을 가로형보다 먼저 적용해 문장 내부 원형 후보를 선택지로 오판하지 않도록 보정 - 2026-05-30
// SOFTM-위치맵: 다음 문제 시작선이 이전 선택지와 실제로 겹칠 때만 작게 밀어 제목이 잘리지 않도록 보정 - 2026-05-30

function adjustQuestionLabelsByChoiceSpacing(pageMap, topMap, questionLabelMap, choiceMap, questionCount, choiceCount, questionColumnBoundsMap = {}){
  const nextTopMap = Array.isArray(topMap) ? topMap.slice() : [];
  const nextLabelMap = { ...(questionLabelMap || {}) };
  const firstChoiceY = (q) => {
    const anchors = Array.isArray(choiceMap?.[String(q)]) ? choiceMap[String(q)] : [];
    const valid = anchors
      .filter((item) => isReliableChoiceAnchor(item, choiceCount))
      .map((item) => Number(item.yRatio))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return valid.length ? valid[0] : null;
  };
  const gaps = [];
  for (let q = 1; q <= questionCount; q += 1){
    const label = nextLabelMap[String(q)];
    const firstY = firstChoiceY(q);
    if (!label || !Number.isFinite(firstY) || Number(label.page) !== Number(pageMap[q])) continue;
    const gap = firstY - Number(label.yRatio);
    if (gap >= 0.035 && gap <= 0.120) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const normalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.070;
  let changed = false;
  for (let q = 2; q <= questionCount; q += 1){
    const currentBounds = questionColumnBoundsMap[String(q)] || {};
    const previousBounds = questionColumnBoundsMap[String(q - 1)] || {};
    if (Number.isFinite(Number(currentBounds.column)) || Number.isFinite(Number(previousBounds.column))) continue;
    if (Number(pageMap[q]) !== Number(pageMap[q - 1])) continue;
    const label = nextLabelMap[String(q)];
    const prevLabel = nextLabelMap[String(q - 1)];
    const firstY = firstChoiceY(q);
    if (!label || !prevLabel || !Number.isFinite(firstY) || Number(label.page) !== Number(pageMap[q])) continue;
    const currentGap = firstY - Number(label.yRatio);
    const prevAnchors = Array.isArray(choiceMap?.[String(q - 1)]) ? choiceMap[String(q - 1)] : [];
    const prevReliableCount = prevAnchors.filter((item) => isReliableChoiceAnchor(item, choiceCount)).length;
    const prevChoiceYs = prevAnchors
      .filter((item) => isReliableChoiceAnchor(item, choiceCount))
      .map((item) => Number(item.yRatio))
      .filter(Number.isFinite);
    const prevMaxChoiceY = prevChoiceYs.length ? Math.max(...prevChoiceYs) : null;
    const labelText = String(label.markerText || label.text || "");
    const labelMarkerSuspicious = new RegExp(`^\\s*${q}\\)`).test(labelText);
    const labelOverlapsPreviousChoices = Number.isFinite(prevMaxChoiceY) && Number(label.yRatio) <= prevMaxChoiceY + 0.030;
    if (prevReliableCount >= Math.max(2, Math.min(choiceCount, 3)) && !labelOverlapsPreviousChoices && !labelMarkerSuspicious) continue;
    const suspiciousGap = (labelOverlapsPreviousChoices || labelMarkerSuspicious) ? Math.max(0.105, normalGap * 1.40) : Math.max(0.125, normalGap * 1.85);
    if (currentGap < suspiciousGap) continue;
    const previousY = Number(prevLabel.yRatio);
    const adjustedY = Math.max(previousY + 0.105, Math.min(firstY - 0.038, firstY - normalGap));
    if (!Number.isFinite(adjustedY) || adjustedY <= Number(label.yRatio) + 0.025) continue;
    nextLabelMap[String(q)] = {
      ...label,
      yRatio: Math.max(0.040, Math.min(0.965, adjustedY)),
      adjustedByChoiceSpacing: true,
      source: "adjusted-choice-spacing",
    };
    nextTopMap[q] = Math.max(0.035, Math.min(0.92, Number(nextLabelMap[String(q)].yRatio) - 0.020));
    changed = true;
  }
  return { changed, topMap: nextTopMap, questionLabelMap: nextLabelMap };
}
// SOFTM-위치맵: 다음 문제번호가 이전 보기 불렛으로 오인되면 다음 문제 첫 보기와의 과도한 간격으로 라벨/segment 시작을 보정 - 2026-06-17

async function cropQuestionAreas(inputDir, outputDir, options = {}){
  const script = `
from PIL import Image, ImageOps
import os, re, sys
src, dest = sys.argv[1], sys.argv[2]
question_count = int(sys.argv[3] or "0")
allow_column_split = question_count > 0 and question_count <= 60
os.makedirs(dest, exist_ok=True)
def page_no_from_name(name, fallback):
    m = re.search(r'(\\d+)', name)
    return int(m.group(1)) if m else fallback

def has_center_divider(im, w, h):
    top = int(h * 0.07)
    bottom = int(h * 0.94)
    if bottom <= top:
        return False
    pix = im.load()
    sample_count = max(1, len(range(top, bottom, 2)))
    best_score = 0.0
    for x in range(int(w * 0.43), int(w * 0.57)):
        hits = 0
        streak = 0
        best_streak = 0
        for y in range(top, bottom, 2):
            if pix[x, y] < 165:
                hits += 1
                streak += 1
                if streak > best_streak:
                    best_streak = streak
            else:
                streak = 0
        ratio = hits / sample_count
        score = ratio + (best_streak / sample_count) * 0.7
        if score > best_score:
            best_score = score
    if best_score >= 0.075:
        return True

    def density(x0, x1, step=5):
        left = int(w * x0)
        right = int(w * x1)
        dark = 0
        total = 0
        for y in range(top, bottom, step):
            for x in range(left, right, step):
                total += 1
                if pix[x, y] < 190:
                    dark += 1
        return dark / max(1, total)

    left_density = density(0.05, 0.45)
    mid_density = density(0.47, 0.53)
    right_density = density(0.55, 0.95)
    return left_density > 0.025 and right_density > 0.025 and (mid_density < min(left_density, right_density) * 0.72 or best_score >= 0.045)

def band_density(im, w, h, x0, x1, y0=0.12, y1=0.90):
    top = int(h * y0)
    bottom = int(h * y1)
    left = int(w * x0)
    right = int(w * x1)
    if bottom <= top or right <= left:
        return 0.0
    pix = im.load()
    x_step = max(1, w // 260)
    y_step = max(1, h // 520)
    dark = 0
    total = 0
    for x in range(left, right, x_step):
        for y in range(top, bottom, y_step):
            total += 1
            if pix[x, y] < 185:
                dark += 1
    return dark / max(1, total)

def wide_text_row_share(im, w, h):
    top = int(h * 0.10)
    bottom = int(h * 0.90)
    pix = im.load()
    y_step = max(2, h // 620)
    x_step = max(1, w // 520)
    wide = 0
    total = 0
    for y in range(top, bottom, y_step):
        xs = []
        for x in range(0, w, x_step):
            if pix[x, y] < 165:
                xs.append(x)
        total += 1
        if len(xs) >= max(8, int(w * 0.026 / x_step)) and min(xs) < w * 0.18 and max(xs) > w * 0.82:
            wide += 1
    return wide / max(1, total)

def has_two_column_density(im, w, h):
    left = band_density(im, w, h, 0.05, 0.43)
    right = band_density(im, w, h, 0.56, 0.93)
    gutter = band_density(im, w, h, 0.46, 0.54)
    return left >= 0.012 and right >= 0.012 and gutter <= max(left, right) * 0.82 and wide_text_row_share(im, w, h) < 0.075

for idx, name in enumerate(sorted(os.listdir(src)), start=1):
    if not name.lower().endswith(".png"):
        continue
    im = Image.open(os.path.join(src, name)).convert("L")
    w, h = im.size
    page_no = page_no_from_name(name, idx)
    top = int(h * 0.035)
    bottom = int(h * 0.95)
    stem, ext = os.path.splitext(name)
    if allow_column_split and (has_center_divider(im, w, h) or has_two_column_density(im, w, h)):
        boxes = [
            (f"{stem}__col0{ext}", (0, top, int(w * 0.515), bottom), "col0"),
            (f"{stem}__col1{ext}", (int(w * 0.485), top, int(w * 0.96), bottom), "col1"),
        ]
    else:
        boxes = [(name, (0, top, int(w * 0.96), bottom), "full")]
    for out_name, box, crop_kind in boxes:
        crop = ImageOps.autocontrast(im.crop(box))
        crop.save(os.path.join(dest, out_name))
        print(f"{out_name}\\t{w}\\t{h}\\t{box[0]}\\t{box[1]}\\t{box[2]-box[0]}\\t{box[3]-box[1]}\\t{page_no}\\t{crop_kind}")
`;
  const result = await run("python3", ["-c", script, inputDir, outputDir, String(options.questionCount || 0)], { maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, width, height, cropX, cropY, cropWidth, cropHeight, page, cropKind] = line.split("\t");
    return {
      name,
      width: Number(width),
      height: Number(height),
      cropX: Number(cropX),
      cropY: Number(cropY),
      cropWidth: Number(cropWidth),
      cropHeight: Number(cropHeight),
      page: Number(page),
      cropKind: cropKind || "full",
    };
  });
}

async function main(){
  const input = arg("--input");
  const output = arg("--output");
  const questionNo = arg("--question-no");
  const questionPdf = arg("--question-pdf", input);
  const questionCount = Number(arg("--question-count", "0")) || 0;
  const configuredStart = Number(arg("--question-start-no", "0")) || 0;
  const configuredEnd = Number(arg("--question-end-no", "0")) || 0;
  const choiceCount = Math.max(1, Math.min(5, Number(arg("--choice-count", "4")) || 4));
  const dpi = Number(arg("--dpi", "220")) || 220;
  if (!input || !output || !questionCount) {
    throw new Error("사용법: node scripts/anchor-ocr.mjs --input file.pdf --output anchor.json --question-count 100");
  }

  const pageCount = parsePdfPages((await run("pdfinfo", [input], { maxBuffer: 4 * 1024 * 1024 })).stdout);
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "quiz-anchor-"));
  const pagePrefix = path.join(workDir, "page");
  const cropDir = path.join(workDir, "crop");
  try{
    console.log(`ANCHOR render dpi=${dpi}`);
    await run("pdftoppm", ["-r", String(dpi), "-png", input, pagePrefix], { maxBuffer: 8 * 1024 * 1024 });
    const cropMeta = await cropQuestionAreas(workDir, cropDir, { questionCount });
    const metaByName = new Map(cropMeta.map((item) => [item.name, item]));
    const cropFiles = fs.readdirSync(cropDir).filter((name) => name.endsWith(".png")).sort();
    const rawAnchors = [];
    const rawChoiceCandidates = [];
    for (let i = 0; i < cropFiles.length; i += 1){
      const name = cropFiles[i];
      const meta = metaByName.get(name) || {};
      const page = Number(meta.page) || (i + 1);
      console.log(`ANCHOR page ${page}/${cropFiles.length}`);
      const tsv = (await run("tesseract", [
        path.join(cropDir, name),
        "stdout",
        "-l", "eng",
        "--psm", "6",
        "-c", "tessedit_char_whitelist=0123456789.()",
        "tsv",
      ], { maxBuffer: 16 * 1024 * 1024 })).stdout;
      const rows = parseTsv(tsv);
      for (const row of rows){
        const choice = detectChoiceToken(row.text);
        if (!choice) continue;
        const left = Number(row.left || 0);
        const top = Number(row.top || 0);
        const width = Number(row.width || 0);
        const height = Number(row.height || 0);
        if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) continue;
        const pageWidth = Math.max(1, Number(meta.width || 1));
        const pageHeight = Math.max(1, Number(meta.height || 1));
        const xRatio = (Number(meta.cropX || 0) + left + (width * 0.5)) / pageWidth;
        const yRatio = (Number(meta.cropY || 0) + top + (height * 0.5)) / pageHeight;
        if (xRatio < 0.018 || xRatio > 0.94 || yRatio < 0.04 || yRatio > 0.965) continue;
        rawChoiceCandidates.push({
          choice,
          page,
          xRatio,
          yRatio,
          wRatio: Math.max(0.004, Math.min(0.10, width / pageWidth)),
          hRatio: Math.max(0.006, Math.min(0.10, height / pageHeight)),
        });
      }
      const lines = groupTsvLines(rows);
      for (const line of lines){
        for (const candidate of detectQuestionLabelCandidates(line, meta)){
          const candidateLine = candidate.line || line;
          const label = candidate.label;
          const yRatio = (Number(meta.cropY || 0) + Number(candidateLine.top || 0)) / Math.max(1, Number(meta.height || 1));
          const xRatio = (Number(meta.cropX || 0) + Number(candidateLine.left || 0)) / Math.max(1, Number(meta.width || 1));
          if (yRatio < 0.04 || yRatio > 0.955) continue;
          const lineHeightRatio = Math.max(0, (Number(candidateLine.bottom || 0) - Number(candidateLine.top || 0)) / Math.max(1, Number(meta.height || 1)));
          rawAnchors.push({
            label,
            page,
            xRatio,
            yRatio,
            text: candidateLine.sourceLineText || candidateLine.text || line.text,
            markerText: candidateLine.text,
            anchorScore: candidate.anchorScore,
            lineHeightRatio,
            source: candidate.source,
          });
        }
      }
    }

    const uniqueLabels = [...new Set(rawAnchors.map((item) => item.label))].sort((a, b) => a - b);
    const { questionStartNo, selected } = inferStartAndSelectAnchors(rawAnchors, configuredStart, questionCount);
    const inferredEndNo = questionStartNo + questionCount - 1;
    const questionEndNo = configuredEnd >= questionStartNo && (configuredEnd - questionStartNo + 1) === questionCount
      ? configuredEnd
      : inferredEndNo;
    const repairedSelectedAnchors = repairColumnTransitionLabelDrift(selected.anchors, questionStartNo, questionCount);
    const anchorByLocal = new Map();
    for (const anchor of repairedSelectedAnchors){
      const q = anchor.label - questionStartNo + 1;
      if (q < 1 || q > questionCount) continue;
      anchorByLocal.set(q, { ...anchor, q });
    }
    const anchors = [...anchorByLocal.values()].sort((a, b) => a.q - b.q);
    let { pageMap, topMap } = fillMissingAnchors(anchorByLocal, pageCount || cropFiles.length, questionCount);
    const pageColumnLayoutMap = buildQuestionColumnLayoutMap(cropMeta);
    const questionColumnBoundsMap = buildQuestionColumnBoundsMap(anchorByLocal, pageMap, questionCount, pageColumnLayoutMap);
    let questionSegments = {};
    let questionLabelMap = completeQuestionLabelMap(anchorByLocal, pageMap, topMap, questionColumnBoundsMap, questionCount);
    let baseQuestionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, {}, questionLabelMap, choiceCount);
    // SOFTM-위치맵: 보기 탐색 시 문제번호 라벨 자체를 선택지로 착각하지 않도록 원본 라벨 좌표를 전달 - 2026-05-30
    const printedQuestionNoMap = Array(questionCount + 1).fill(null);
    for (let q = 1; q <= questionCount; q += 1){
      printedQuestionNoMap[q] = questionStartNo + q - 1;
    }
    let imageChoiceMap = {};
    try{
      imageChoiceMap = await detectChoiceAnchorsFromImages(workDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap, questionColumnBoundsMap, baseQuestionSegments, rawChoiceCandidates);
      const adjusted = adjustTopMapByChoiceAnchors(pageMap, topMap, imageChoiceMap, questionCount, choiceCount, questionLabelMap);
      if (adjusted.changed) {
        topMap = adjusted.topMap;
        baseQuestionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, {}, questionLabelMap, choiceCount);
        imageChoiceMap = await detectChoiceAnchorsFromImages(workDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap, questionColumnBoundsMap, baseQuestionSegments, rawChoiceCandidates);
      }
      const labelAdjusted = adjustQuestionLabelsByChoiceSpacing(pageMap, topMap, questionLabelMap, imageChoiceMap, questionCount, choiceCount, questionColumnBoundsMap);
      if (labelAdjusted.changed) {
        topMap = labelAdjusted.topMap;
        questionLabelMap = labelAdjusted.questionLabelMap;
        baseQuestionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, {}, questionLabelMap, choiceCount);
        imageChoiceMap = await detectChoiceAnchorsFromImages(workDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap, questionColumnBoundsMap, baseQuestionSegments, rawChoiceCandidates);
      }
    }catch(err){
      console.error(`ANCHOR choice image detect skipped: ${err?.message || err}`);
    }
    // SOFTM-위치맵: 선택지와 겹친 다음 문제 시작선을 보정한 뒤 선택지 위치를 재탐지 - 2026-05-30
	    const reliableChoiceMap = repairGridChoiceMap(
	      normalizeReliableChoiceMap(imageChoiceMap, questionCount, choiceCount, baseQuestionSegments),
	      baseQuestionSegments,
	      questionCount,
      choiceCount,
    ); // SOFTM-문항영역: OCR 오탐 제거 뒤 2행 선택지의 한 칸 누락은 기하 관계로 보수 복구 - 2026-06-16
    const choiceAnchorMapBeforePixelSnap = repairQuestionLineGridChoiceMap(repairCollapsedLowerGridChoiceMap(snapFallbackChoiceAnchorsToRawCandidates(buildSegmentChoiceAnchorFallbackMap(
      repairLeadingVerticalChoiceMap(
        completeTrailingChoiceMap(
          reliableChoiceMap,
          baseQuestionSegments,
          questionCount,
          choiceCount,
        ),
        baseQuestionSegments,
        questionLabelMap,
        questionCount,
        choiceCount,
      ),
      baseQuestionSegments,
      questionColumnBoundsMap,
      pageMap,
      questionCount,
      choiceCount,
      questionLabelMap,
    ), rawChoiceCandidates, baseQuestionSegments, questionColumnBoundsMap, questionCount, choiceCount), baseQuestionSegments, questionCount, choiceCount), baseQuestionSegments, questionLabelMap, questionCount, choiceCount); // SOFTM-문항앵커: segment fallback과 OCR 후보 보정 뒤 grid/horizontal 최종 형태를 복원 - 2026-06-18
    const choiceAnchorMap = alignGridFallbackRowsToSnappedSiblings(repairBoxOptionUpperGridChoiceMap(await snapFallbackChoiceAnchorsToRenderedMarks(workDir, choiceAnchorMapBeforePixelSnap, baseQuestionSegments, questionCount, choiceCount), baseQuestionSegments, questionCount, choiceCount), questionCount, choiceCount); // SOFTM-문항앵커: 최종 fallback 앵커를 렌더 픽셀 후보/박스형 행/스냅 형제 row 기준으로 보정 - 2026-06-19
    questionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, choiceAnchorMap, questionLabelMap, choiceCount);
    let choiceClickAreaMap = {};
    try{
      choiceClickAreaMap = await buildPreciseChoiceClickAreaMapFromRenderedPages(workDir, choiceAnchorMap, questionSegments, questionColumnBoundsMap, questionLabelMap, questionCount, choiceCount);
    }catch(err){
      console.error(`ANCHOR choice click area detect skipped: ${err?.message || err}`);
      choiceClickAreaMap = {};
    } // SOFTM-문항영역: 위치맵 생성도 렌더 PNG 픽셀 기반 정밀 문항영역을 저장 - 2026-06-16
    const choiceStats = summarizeChoiceAnchorMap(choiceAnchorMap, questionCount, choiceCount);
    const parserDiagnostics = validateAnchorConsistency(pageMap, questionSegments, choiceAnchorMap, questionCount, choiceCount);
    const detectedRatio = anchors.length / Math.max(1, questionCount);
    const pageCoverage = new Set(anchors.map((item) => item.page)).size / Math.max(1, pageCount || cropFiles.length);
    const confidence = Math.max(0.05, Math.min(0.98, (detectedRatio * 0.70) + (pageCoverage * 0.12) + (choiceStats.coverage * 0.18)));
    const warnings = [];
    if (anchors.length < Math.max(3, questionCount * 0.75)) warnings.push(`예상 문제 수(${questionCount}) 대비 문제 위치 감지가 부족합니다(${anchors.length}개).`);
    if (choiceStats.detected < Math.max(1, Math.floor(choiceStats.expected * 0.80))) warnings.push(`선택지 위치 감지가 부족합니다(${choiceStats.detected}/${choiceStats.expected}). 누락 문항은 풀이 화면에서 직접 확인하거나 관리자에서 보정하세요.`);
    else if (choiceStats.detected < choiceStats.expected) warnings.push(`일부 선택지 위치가 누락되었습니다(${choiceStats.detected}/${choiceStats.expected}). 틀린 좌표 대신 누락으로 표시합니다.`);
    if (parserDiagnostics.outOfSegmentChoiceCount > 0) warnings.push(`위치맵 검증: 선택지 ${parserDiagnostics.outOfSegmentChoiceCount}개가 문제 영역 밖에 있어 확인이 필요합니다.`);
    if (parserDiagnostics.suspiciousChoiceOrderCount > 0) warnings.push(`위치맵 검증: 선택지 순서가 비정상인 문항 ${parserDiagnostics.suspiciousChoiceOrderCount}개가 있습니다.`);
    if (!configuredStart && questionStartNo !== 1) warnings.push(`인쇄 문항 시작 번호를 ${questionStartNo}번으로 추정했습니다.`);
    if (confidence < 0.32) warnings.push("문제·문항 위치맵 신뢰도가 낮아 풀이 화면에서 넓은 fallback이 함께 사용될 수 있습니다.");

    const data = {
      version: 1,
      kind: "question-anchor-map",
      questionNo,
      questionPdf,
      pageCount: pageCount || cropFiles.length,
      questionCount,
      choiceCount,
      questionStartNo,
      questionEndNo,
      printedQuestionNoMap,
      questionLabelMap,
      questionColumnBoundsMap,
      questionSegments,
      questionPageMap: pageMap,
      questionTopRatioMap: topMap,
      choiceAnchorMap,
      choiceClickAreaMap,
      anchors,
      rawAnchorCount: rawAnchors.length,
      sourceStats: {
        questionDetected: anchors.length,
        questionExpected: questionCount,
        ocrChoiceCandidateCount: rawChoiceCandidates.length,
        choiceDetected: choiceStats.detected,
        choiceExpected: choiceStats.expected,
        choiceCoverage: choiceStats.coverage,
        choiceClickAreaDetected: Object.values(choiceClickAreaMap).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0),
        choiceMissingQuestions: choiceStats.missingQuestions,
        parserDiagnostics,
      },
      confidence,
      warnings,
      generatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    console.log(`ANCHOR done ${output}`);
    console.log(JSON.stringify({
      ok: true,
      output,
      detected: anchors.length,
      rawDetected: rawAnchors.length,
      pageCount: data.pageCount,
      questionStartNo,
      questionEndNo,
      confidence,
      warnings,
    }));
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
/* SOFTM-위치맵 끝 */
