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
        && candidates[i].yRatio - candidates[j].yRatio < 0.045
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

function buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, choiceAnchorMap = {}, questionLabelMap = {}){
  const out = {};
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const boundsFor = (q) => {
    const bounds = questionColumnBoundsMap[String(q)] || {};
    const left = Number.isFinite(Number(bounds.left)) ? clamp(Number(bounds.left), 0, 1) : 0;
    const right = Number.isFinite(Number(bounds.right)) ? clamp(Number(bounds.right), 0, 1) : 1;
    return {
      left,
      right,
      column: Number.isFinite(Number(bounds.column)) ? Number(bounds.column) : null,
    };
  };
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
        start = Math.max(start, clamp(currentLabelTop - 0.020, 0.02, 0.97));
      }
    }
    let end = 0.95;
    let hardEnd = null;
    for (let next = q + 1; next <= questionCount; next += 1){
      if (Number(pageMap[next]) !== page) continue;
      const nextLane = boundsFor(next);
      if (!sameSegmentLane(currentLane, nextLane)) continue;
      const nextTop = Number(topMap[next]);
      const nextLabelTop = Number(questionLabelMap[String(next)]?.yRatio);
      const hasNextLabel = Number.isFinite(nextLabelTop) && nextLabelTop > start + 0.018;
      const nextBoundary = hasNextLabel ? nextLabelTop : nextTop;
      if (!Number.isFinite(nextBoundary) || nextBoundary <= start + 0.018) continue;
      hardEnd = clamp(nextBoundary - (hasNextLabel ? 0.020 : 0.010), start + 0.05, 0.97);
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
      end = Math.max(end, hardEnd == null ? extendedEnd : Math.min(extendedEnd, hardEnd));
    }
    if (end <= start + 0.045) end = clamp(start + 0.16, start + 0.05, 0.97);
    out[String(q)] = [{
      page,
      top: clamp(start, 0.020, 0.97),
      bottom: clamp(end, Math.min(0.97, start + 0.05), 0.98),
      left: currentLane.left,
      right: currentLane.right,
      column: currentLane.column,
      source: currentLane.column != null ? "column-segment" : "page-segment",
    }];
  }
  return out;
}
// SOFTM-위치맵: 문제번호 흐름으로 확정한 문제 영역을 저장해 한문제 보기가 컬럼/영역 조각을 직접 사용하도록 지원 - 2026-06-01

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
        if item["xRatio"] < 0.13 and item.get("fill", 0) > 0.34 and item.get("wRatio", 0) < 0.012 and item.get("hRatio", 0) < 0.016:
            continue
        # SOFTM-위치맵: 페이지 첫 문항의 5. 같은 좁고 진한 문제번호 숫자를 원형 보기 ①로 오인하지 않도록 제외 - 2026-05-30
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
        if question_start is not None and row["y"] - float(question_start) < 0.045:
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
    choice_question_start = start
    try:
        if label_anchor and int(label_anchor.get("page") or 0) == page:
            choice_question_start = max(choice_question_start, float(label_anchor.get("yRatio") or choice_question_start))
    except Exception:
        choice_question_start = start
    label_exclusion_dx = 0.018 if compact_bounds else 0.045
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
            and abs(item["yRatio"] - float(label_anchor.get("yRatio") or -1)) <= 0.032
        )
        and not (
            next_label_anchor
            and int(next_label_anchor.get("page") or 0) == page
            and abs(item["xRatio"] - float(next_label_anchor.get("xRatio") or -1)) <= label_exclusion_dx
            and abs(item["yRatio"] - float(next_label_anchor.get("yRatio") or -1)) <= 0.032
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
            if not (small_middle and small_tail):
                return None
            start = float(question_start) if question_start is not None else 0.0
            bottom_y = (float(anchors[1].get("yRatio")) + float(anchors[3].get("yRatio"))) * 0.5
            if bottom_y - start < 0.110:
                return None
            gap = clamp((bottom_y - start) * 0.36, 0.042, 0.070)
            top_y = bottom_y - gap
            if question_end is not None and bottom_y > float(question_end) + 0.030:
                return None
            if top_y <= start + 0.035:
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
        if compact or choice_count != 4 or raw_band > 0.122:
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

    compact_column = compact_bounds
    rows = rows_from(candidates)
    horizontal = normalize_layout_score(score_horizontal(rows, choice_count, expected_horizontal_y, start, compact_column))
    grid = normalize_layout_score(score_grid(rows, choice_count, expected_grid_y, start, compact_column))
    vertical = normalize_layout_score(score_vertical(rows, choice_count, expected_vertical_y, choice_question_start, high, compact_column))
    outline_vertical = normalize_layout_score(score_outline_vertical(rows, choice_count, expected_vertical_y, choice_question_start, high, compact_column))
    rescued_grid = normalize_layout_score(rescue_lower_grid_from_horizontal(horizontal, choice_question_start, high, compact_column))
    if rescued_grid and (not grid or float(rescued_grid.get("score", 0)) >= float(grid.get("score", 0)) - 0.75):
        grid = rescued_grid
    picked = pick_layout(horizontal, grid, vertical, choice_count, bool(compact_column or (box_floor is not None and choice_count == 4) or rescued_grid))
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
                        and abs(item["yRatio"] - float(label_anchor.get("yRatio") or -1)) <= 0.032
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
  const confidence = item.confidence == null ? 1 : Number(item.confidence);
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

function normalizeReliableChoiceMap(imageMap, questionCount, choiceCount){
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
      out[String(q)] = Array.from(byChoice.values()).sort((a, b) => Number(a.choice) - Number(b.choice));
    }
  }
  return out;
}

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
      if (
        gaps.length >= 2
        && medianGap >= 0.010
        && medianGap <= 0.060
        && Number.isFinite(inferredY)
        && inferredY > ys.at(-1) + 0.008
        && inferredY <= Math.min(0.965, (Number.isFinite(segmentBottom) ? segmentBottom + 0.030 : 0.965))
      ) {
        const base = anchors.at(-1);
        anchors.push({
          ...base,
          choice: 4,
          xRatio: xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : base.xRatio,
          yRatio: inferredY,
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
// SOFTM-위치맵: 세로형 ①②③이 확실하고 ④만 약하게 빠진 경우 JS 후처리에서 마지막 보기를 보수적으로 복원 - 2026-06-01

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
  const segmentFor = (q, page) => {
    const segments = questionSegments && Array.isArray(questionSegments[String(q)]) ? questionSegments[String(q)] : [];
    return segments.find((segment) => Number(segment.page) === Number(page)) || null;
  };
  for (let q = 1; q <= questionCount; q += 1){
    const page = Number(pageMap[q]);
    const segment = segmentFor(q, page);
    if (!segment) {
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
      const top = Number(segment.top);
      const bottom = Number(segment.bottom);
      const left = Number(segment.left ?? 0);
      const right = Number(segment.right ?? 1);
      const inSegment = Number(item.page) === page
        && Number.isFinite(x)
        && Number.isFinite(y)
        && Number.isFinite(top)
        && Number.isFinite(bottom)
        && y >= top - 0.018
        && y <= bottom + 0.030
        && x >= left - 0.030
        && x <= right + 0.030;
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
    const questionLabelMap = completeQuestionLabelMap(anchorByLocal, pageMap, topMap, questionColumnBoundsMap, questionCount);
    let baseQuestionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, {}, questionLabelMap);
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
        baseQuestionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, {}, questionLabelMap);
        imageChoiceMap = await detectChoiceAnchorsFromImages(workDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap, questionColumnBoundsMap, baseQuestionSegments, rawChoiceCandidates);
      }
    }catch(err){
      console.error(`ANCHOR choice image detect skipped: ${err?.message || err}`);
    }
    // SOFTM-위치맵: 선택지와 겹친 다음 문제 시작선을 보정한 뒤 선택지 위치를 재탐지 - 2026-05-30
    const choiceAnchorMap = completeTrailingChoiceMap(
      normalizeReliableChoiceMap(imageChoiceMap, questionCount, choiceCount),
      baseQuestionSegments,
      questionCount,
      choiceCount,
    );
    questionSegments = buildQuestionSegments(pageMap, topMap, questionColumnBoundsMap, questionCount, choiceAnchorMap, questionLabelMap);
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
      anchors,
      rawAnchorCount: rawAnchors.length,
      sourceStats: {
        questionDetected: anchors.length,
        questionExpected: questionCount,
        ocrChoiceCandidateCount: rawChoiceCandidates.length,
        choiceDetected: choiceStats.detected,
        choiceExpected: choiceStats.expected,
        choiceCoverage: choiceStats.coverage,
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
