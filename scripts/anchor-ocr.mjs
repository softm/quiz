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
  if (leftRatio > 0.36) return null;
  let match = compact.match(/^(\d{1,3})[.)]/);
  if (!match) match = text.match(/^(\d{1,3})[.)]/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1 || value > 999) return null;
  return value;
}

function sortedAnchorCandidates(rawAnchors){
  return rawAnchors.slice().sort((a, b) => (
    a.page - b.page
    || a.yRatio - b.yRatio
    || a.xRatio - b.xRatio
    || a.label - b.label
  ));
}

function selectMonotonicAnchors(rawAnchors, startNo, questionCount){
  const endNo = startNo + questionCount - 1;
  const candidates = sortedAnchorCandidates(rawAnchors)
    .filter((item) => item.label >= startNo && item.label <= endNo);
  const n = candidates.length;
  if (!n) return { anchors: [], score: 0 };
  const dp = Array(n).fill(1);
  const prev = Array(n).fill(-1);
  for (let i = 0; i < n; i += 1){
    for (let j = 0; j < i; j += 1){
      if (candidates[j].label >= candidates[i].label) continue;
      const pageOrderOk = candidates[j].page < candidates[i].page
        || (candidates[j].page === candidates[i].page && candidates[j].yRatio + 0.006 < candidates[i].yRatio);
      if (!pageOrderOk) continue;
      const gapPenalty = Math.min(0.25, Math.max(0, candidates[i].label - candidates[j].label - 1) * 0.01);
      const nextScore = dp[j] + 1 - gapPenalty;
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
  let best = { questionStartNo: 1, selected: selectMonotonicAnchors(rawAnchors, 1, questionCount) };
  for (const start of starts){
    const selected = selectMonotonicAnchors(rawAnchors, start, questionCount);
    const configuredBonus = configuredStart && start === configuredStart ? 0.18 : 0;
    const currentScore = selected.score + configuredBonus;
    const bestScore = best.selected.score + (best.questionStartNo === 1 ? 0.03 : 0);
    if (currentScore > bestScore) best = { questionStartNo: start, selected };
  }
  return best;
}
// SOFTM-위치맵: PDF 문제번호가 1이 아닌 시작번호여도 자동 추론하고, 기존 시작번호는 낮은 가중치 힌트로만 사용 - 2026-05-30

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
      if (prev.page === next.page) {
        topMap[q] = prev.yRatio + ((next.yRatio - prev.yRatio) * ratio);
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
    if (prevKnown && Number(prevKnown.page) < page) {
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
      const projected = firstGap > 0.12 && missingBeforeFirst.length > 1
        ? pageTop + (firstGap * (idx + 1) / (missingBeforeFirst.length + 1))
        : pageTop + (idx * 0.072);
      const limit = Math.max(0.045, Number(firstKnown.yRatio) - (0.05 * (missingBeforeFirst.length - idx)));
      topMap[q] = Math.max(0.045, Math.min(limit, projected));
    });
  }
  // SOFTM-위치맵: 새 PDF 페이지의 첫 문제번호 OCR이 누락되면 실제 상단 여백 폭에 맞춰 누락 문제 시작선을 분배 - 2026-05-30
  for (let q = 1; q <= questionCount; q++){
    pageMap[q] = Math.max(1, Math.min(pageCount || 1, Number(pageMap[q]) || 1));
    topMap[q] = Math.max(0.035, Math.min(0.92, (Number(topMap[q]) || 0.12) - 0.030));
  }
  // SOFTM-위치맵: 문제 시작선이 제목 글자를 가로지르지 않도록 컷 시작 위치를 더 위로 보정 - 2026-05-30
  return { pageMap, topMap };
}

async function detectChoiceAnchorsFromImages(pageDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap = {}){
  const mapPath = path.join(pageDir, "choice-map-input.json");
  await fsp.writeFile(mapPath, JSON.stringify({ pageMap, topMap, questionCount, choiceCount, questionLabelMap }), "utf8");
  const script = `
import json, os, sys
from PIL import Image
import numpy as np
from scipy import ndimage

page_dir, map_path = sys.argv[1], sys.argv[2]
meta = json.load(open(map_path, "r", encoding="utf-8"))
page_map = meta["pageMap"]
top_map = meta["topMap"]
question_label_map = meta.get("questionLabelMap") or {}
question_count = int(meta["questionCount"])
choice_count = max(1, min(5, int(meta["choiceCount"] or 4)))
files = sorted([name for name in os.listdir(page_dir) if name.lower().endswith(".png")])

def clamp(value, lo, hi):
    return max(lo, min(hi, value))

def x_template(count, layout):
    if layout == "horizontal":
        if count == 5:
            return [0.085, 0.245, 0.405, 0.585, 0.765]
        if count == 4:
            return [0.085, 0.305, 0.525, 0.725] # SOFTM-위치맵: 가로형 4번 보기 기준점을 실제 원형 번호 위치에 맞춰 본문 글자 오탐을 방지 - 2026-05-30
        return [0.085 + (idx * (0.76 / max(1, count - 1))) for idx in range(count)]
    if layout == "grid":
        return [0.085, 0.515]
    return [0.085]

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
        if cx < 0.04 or cx > 0.92 or cy < 0.04 or cy > 0.93:
            continue
        lx0 = max(0, x0 - 34)
        lx1 = max(0, x0 - 5)
        ly0 = max(0, y0 - 3)
        ly1 = min(h, y1 + 3)
        left_density = 0.0
        if lx1 > lx0 and ly1 > ly0:
            left_density = float(np.mean(arr[ly0:ly1, lx0:lx1] < 125))
        out.append({"xRatio": cx, "yRatio": cy, "wRatio": bw / w, "hRatio": bh / h, "fill": fill, "leftDensity": left_density})
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
    has_dense_digit = any(item.get("fill", 0) > 0.28 and item.get("wRatio", 0) < 0.012 and item.get("hRatio", 0) < 0.016 for item in left)
    return has_dense_digit and left[-1]["xRatio"] - left[0]["xRatio"] <= 0.024
    # SOFTM-위치맵: 77.처럼 분리된 좁은 문제번호 숫자 행은 원형 선택지 행과 구분 - 2026-05-30

def nearest(row_items, expected_x, used, max_dx=0.06):
    best = None
    best_score = 999
    for idx, item in enumerate(row_items):
        if idx in used:
            continue
        dx = abs(item["xRatio"] - expected_x)
        if dx > max_dx:
            continue
        if item.get("leftDensity", 0) > 0.16:
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

def score_horizontal(rows, choice_count, expected_y):
    best = None
    xs = x_template(choice_count, "horizontal")
    for row in rows:
        if row_has_question_number_prefix(row):
            continue
        # SOFTM-위치맵: 문제번호가 포함된 제목 행을 가로형 ①~④ 보기 행으로 채택하지 않도록 제외 - 2026-05-30
        used = set()
        found_by_choice = {}
        dx_sum = 0
        for choice, x in enumerate(xs, start=1):
            found = nearest(row["items"], x, used, 0.065)
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
        score = (len(found_by_choice) * 12) - (dx_sum * 45) - (y_penalty * 34)
        if best is None or score > best["score"]:
            best = {"score": score, "anchors": anchors, "layout": "horizontal", "foundCount": len(found_by_choice), "yDistance": y_penalty, "firstY": min(anchor[1]["yRatio"] for anchor in anchors), "lastY": max(anchor[1]["yRatio"] for anchor in anchors)}
    return best

def score_grid(rows, choice_count, expected_y, question_start=None):
    if choice_count < 4:
        return None
    best = None
    sorted_rows = sorted(rows, key=lambda row: row["y"])
    for i, top in enumerate(sorted_rows):
        for bottom in sorted_rows[i + 1:]:
            gap = bottom["y"] - top["y"]
            if gap < 0.018:
                continue
            if gap > 0.145: # SOFTM-위치맵: 보기 2행 간격이 큰 문제도 그리드 후보로 유지 - 2026-05-30
                break
            if question_start is not None and top["y"] - float(question_start) < 0.045 and gap > 0.045 and bottom["y"] - float(question_start) > 0.080:
                continue
            # SOFTM-위치맵: 바로 아래 문제 제목을 2행 그리드 하단 선택지로 섞는 오탐을 제외 - 2026-05-30
            used_top = set()
            used_bottom = set()
            t_left = nearest(top["items"], 0.085, used_top, 0.035)
            if t_left: used_top.add(t_left[0])
            t_right = nearest(top["items"], 0.515, used_top, 0.035)
            if t_right: used_top.add(t_right[0])
            b_left = nearest(bottom["items"], 0.085, used_bottom, 0.035)
            if b_left: used_bottom.add(b_left[0])
            b_right = nearest(bottom["items"], 0.515, used_bottom, 0.035)
            found = [v for v in [t_left, t_right, b_left, b_right] if v]
            if len(found) < 4:
                continue
            anchors = [
                (1, t_left[1]),
                (2, t_right[1]),
                (3, b_left[1]),
                (4, b_right[1]),
            ]
            if any(anchor[0] in (1, 3) and anchor[1]["xRatio"] < 0.092 for anchor in anchors):
                continue
            # SOFTM-위치맵: 왼쪽 열 후보가 페이지 가장자리 본문 글자에 붙으면 가짜 2행 선택지로 보고 제외 - 2026-05-30
            dx_sum = sum(v[2] for v in found)
            y_mid = (top["y"] + bottom["y"]) * 0.5
            y_distance = abs(y_mid - expected_y)
            score = (len(found) * 15) - (dx_sum * 45) - (y_distance * 10) - (abs(gap - 0.036) * 18)
            if best is None or score > best["score"]:
                best = {"score": score, "anchors": anchors[:choice_count], "layout": "grid", "foundCount": len(found), "yDistance": y_distance, "gap": gap, "firstY": min(anchor[1]["yRatio"] for anchor in anchors[:choice_count]), "lastY": max(anchor[1]["yRatio"] for anchor in anchors[:choice_count])}
    return best

def score_vertical(rows, choice_count, expected_y, question_start=None):
    x = x_template(choice_count, "vertical")[0]
    found_rows = []
    for row in sorted(rows, key=lambda row: row["y"]):
        found = nearest(row["items"], x, set(), 0.035)
        if not found:
            continue
        _, item, dx = found
        found_rows.append((row["y"], item, dx))
    min_required = max(2, min(choice_count, 3))
    if len(found_rows) < min_required:
        return None
    found_rows = found_rows[:choice_count]
    start_choice = 1
    if len(found_rows) < choice_count and question_start is not None:
        first_y = found_rows[0][0] if found_rows else 0
        if first_y - float(question_start) > 0.045:
            start_choice = max(1, choice_count - len(found_rows) + 1)
    anchors = [(start_choice + idx, item) for idx, (_, item, _) in enumerate(found_rows)]
    if len(anchors) < min_required:
        return None
    # SOFTM-위치맵: 세로형 선택지는 위에서부터 매핑하되 첫 보기가 누락된 경우 번호를 당겨 붙이지 않도록 보정 - 2026-05-30
    y_distance = abs(((anchors[0][1]["yRatio"] + anchors[-1][1]["yRatio"]) * 0.5) - expected_y)
    score = (len(found_rows) * 12) - (sum(item[2] for item in found_rows) * 40) - (y_distance * 8)
    return {"score": score, "anchors": anchors, "layout": "vertical", "foundCount": len(found_rows), "yDistance": y_distance, "firstY": min(anchor[1]["yRatio"] for anchor in anchors), "lastY": max(anchor[1]["yRatio"] for anchor in anchors)}

def valid_layout(item, choice_count):
    if not item:
        return False
    count = len(item["anchors"])
    xs = [anchor[1]["xRatio"] for anchor in item["anchors"]]
    ys = [anchor[1]["yRatio"] for anchor in item["anchors"]]
    x_span = max(xs) - min(xs)
    y_span = max(ys) - min(ys)
    if item.get("layout") == "horizontal":
        return count >= choice_count and x_span > 0.30 and y_span < 0.04
    # SOFTM-위치맵: 가로형 선택지는 일부만 잡히면 본문 글자를 보기로 오판하는 경우가 많아 완전 검출만 인정 - 2026-05-30
    if item.get("layout") == "grid":
        return count >= min(choice_count, 4) and x_span > 0.32 and y_span > 0.018
    if item.get("layout") == "vertical":
        return count >= max(2, min(choice_count, 3)) and x_span < 0.09 and y_span > 0.045 and y_span < 0.22
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
for page_no, name in enumerate(files, start=1):
    by_page[page_no] = page_features(os.path.join(page_dir, name))

result = {}
for q in range(1, question_count + 1):
    try:
        page = int(page_map[q])
        start = float(top_map[q])
    except Exception:
        continue
    end = None
    page_tail = False
    for next_q in range(q + 1, question_count + 1):
        try:
            if int(page_map[next_q]) != page:
                break
            next_top = float(top_map[next_q])
        except Exception:
            continue
        if next_top > start + 0.035:
            end = next_top
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
    box_floor = stimulus_floor_after_start(page_feature.get("horizontalLines", []), start, end)
    if box_floor is not None:
        low = max(low, min(high - 0.018, box_floor + 0.010))
        expected_horizontal_y = max(expected_horizontal_y, min(high, low + 0.020))
        expected_grid_y = max(expected_grid_y, min(high, low + 0.035))
        expected_vertical_y = max(expected_vertical_y, min(high, low + 0.035))
    label_anchor = question_label_map.get(str(q)) or {}
    candidates = [
        item for item in page_feature.get("candidates", [])
        if low <= item["yRatio"] <= high
        and not (item["xRatio"] < 0.13 and item["yRatio"] < start + 0.014)
        and not (
            label_anchor
            and int(label_anchor.get("page") or 0) == page
            and abs(item["xRatio"] - float(label_anchor.get("xRatio") or -1)) <= 0.045
            and abs(item["yRatio"] - float(label_anchor.get("yRatio") or -1)) <= 0.032
        )
    ]
    # SOFTM-위치맵: 지문/표 박스가 있는 문항은 박스 하단 이후 선택지 행만 탐색하고, 문제번호 바로 아래 첫 보기는 제외하지 않도록 상단 오탐 범위를 축소 - 2026-05-30
    rows = rows_from(candidates)
    horizontal = score_horizontal(rows, choice_count, expected_horizontal_y)
    grid = score_grid(rows, choice_count, expected_grid_y, start)
    vertical = score_vertical(rows, choice_count, expected_vertical_y, start)
    picked = pick_layout(horizontal, grid, vertical, choice_count, bool(box_floor is not None and choice_count == 4))
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
            "xRatio": item["xRatio"],
            "yRatio": item["yRatio"],
            "wRatio": max(0.01, item["wRatio"]),
            "hRatio": max(0.012, item["hRatio"]),
            "source": item.get("source", "anchor-image"),
            "anchorMode": "center", # SOFTM-위치맵: 이미지 선택지 앵커가 중심좌표임을 명시 - 2026-05-30
            "layout": picked.get("layout"),
            "confidence": anchor_confidence
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

function adjustTopMapByChoiceAnchors(pageMap, topMap, choiceMap, questionCount, choiceCount){
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

async function cropQuestionAreas(inputDir, outputDir){
  const script = `
from PIL import Image, ImageOps
import os, sys
src, dest = sys.argv[1], sys.argv[2]
os.makedirs(dest, exist_ok=True)
for name in sorted(os.listdir(src)):
    if not name.lower().endswith(".png"):
        continue
    im = Image.open(os.path.join(src, name)).convert("L")
    w, h = im.size
    box = (0, int(h * 0.06), int(w * 0.52), int(h * 0.91))
    crop = ImageOps.autocontrast(im.crop(box))
    crop.save(os.path.join(dest, name))
    print(f"{name}\\t{w}\\t{h}\\t{box[0]}\\t{box[1]}\\t{box[2]-box[0]}\\t{box[3]-box[1]}")
`;
  const result = await run("python3", ["-c", script, inputDir, outputDir], { maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, width, height, cropX, cropY, cropWidth, cropHeight] = line.split("\t");
    return {
      name,
      width: Number(width),
      height: Number(height),
      cropX: Number(cropX),
      cropY: Number(cropY),
      cropWidth: Number(cropWidth),
      cropHeight: Number(cropHeight),
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
    const cropMeta = await cropQuestionAreas(workDir, cropDir);
    const metaByName = new Map(cropMeta.map((item) => [item.name, item]));
    const cropFiles = fs.readdirSync(cropDir).filter((name) => name.endsWith(".png")).sort();
    const rawAnchors = [];
    for (let i = 0; i < cropFiles.length; i += 1){
      const name = cropFiles[i];
      const page = i + 1;
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
      const meta = metaByName.get(name) || {};
      const lines = groupTsvLines(rows);
      for (const line of lines){
        const label = detectQuestionLabel(line, meta.cropWidth || 1);
        if (!label) continue;
        const yRatio = (Number(meta.cropY || 0) + Number(line.top || 0)) / Math.max(1, Number(meta.height || 1));
        const xRatio = (Number(meta.cropX || 0) + Number(line.left || 0)) / Math.max(1, Number(meta.width || 1));
        if (yRatio < 0.04 || yRatio > 0.92) continue;
        rawAnchors.push({ label, page, xRatio, yRatio, text: line.text });
      }
    }

    const uniqueLabels = [...new Set(rawAnchors.map((item) => item.label))].sort((a, b) => a - b);
    const { questionStartNo, selected } = inferStartAndSelectAnchors(rawAnchors, configuredStart, questionCount);
    const questionEndNo = configuredEnd || (questionStartNo + questionCount - 1);
    const anchorByLocal = new Map();
    for (const anchor of selected.anchors){
      const q = anchor.label - questionStartNo + 1;
      if (q < 1 || q > questionCount) continue;
      anchorByLocal.set(q, { ...anchor, q });
    }
    const anchors = [...anchorByLocal.values()].sort((a, b) => a.q - b.q);
    let { pageMap, topMap } = fillMissingAnchors(anchorByLocal, pageCount || cropFiles.length, questionCount);
    const questionLabelMap = {};
    for (const [q, anchor] of anchorByLocal.entries()){
      questionLabelMap[String(q)] = {
        page: anchor.page,
        xRatio: anchor.xRatio,
        yRatio: anchor.yRatio,
      };
    }
    // SOFTM-위치맵: 보기 탐색 시 문제번호 라벨 자체를 선택지로 착각하지 않도록 원본 라벨 좌표를 전달 - 2026-05-30
    const printedQuestionNoMap = Array(questionCount + 1).fill(null);
    for (let q = 1; q <= questionCount; q += 1){
      printedQuestionNoMap[q] = questionStartNo + q - 1;
    }
    let imageChoiceMap = {};
    try{
      imageChoiceMap = await detectChoiceAnchorsFromImages(workDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap);
      const adjusted = adjustTopMapByChoiceAnchors(pageMap, topMap, imageChoiceMap, questionCount, choiceCount);
      if (adjusted.changed) {
        topMap = adjusted.topMap;
        imageChoiceMap = await detectChoiceAnchorsFromImages(workDir, pageMap, topMap, questionCount, choiceCount, questionLabelMap);
      }
    }catch(err){
      console.error(`ANCHOR choice image detect skipped: ${err?.message || err}`);
    }
    // SOFTM-위치맵: 선택지와 겹친 다음 문제 시작선을 보정한 뒤 선택지 위치를 재탐지 - 2026-05-30
    const choiceAnchorMap = normalizeReliableChoiceMap(imageChoiceMap, questionCount, choiceCount);
    const choiceStats = summarizeChoiceAnchorMap(choiceAnchorMap, questionCount, choiceCount);
    const detectedRatio = anchors.length / Math.max(1, questionCount);
    const pageCoverage = new Set(anchors.map((item) => item.page)).size / Math.max(1, pageCount || cropFiles.length);
    const confidence = Math.max(0.05, Math.min(0.98, (detectedRatio * 0.70) + (pageCoverage * 0.12) + (choiceStats.coverage * 0.18)));
    const warnings = [];
    if (anchors.length < Math.max(3, questionCount * 0.75)) warnings.push(`예상 문제 수(${questionCount}) 대비 문제 위치 감지가 부족합니다(${anchors.length}개).`);
    if (choiceStats.detected < Math.max(1, Math.floor(choiceStats.expected * 0.80))) warnings.push(`선택지 위치 감지가 부족합니다(${choiceStats.detected}/${choiceStats.expected}). 누락 문항은 풀이 화면에서 직접 확인하거나 관리자에서 보정하세요.`);
    else if (choiceStats.detected < choiceStats.expected) warnings.push(`일부 선택지 위치가 누락되었습니다(${choiceStats.detected}/${choiceStats.expected}). 틀린 좌표 대신 누락으로 표시합니다.`);
    if (!configuredStart && uniqueLabels[0] && uniqueLabels[0] !== 1) warnings.push(`인쇄 문항 시작 번호를 ${uniqueLabels[0]}번으로 추정했습니다.`);
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
      questionPageMap: pageMap,
      questionTopRatioMap: topMap,
      choiceAnchorMap,
      anchors,
      rawAnchorCount: rawAnchors.length,
      sourceStats: {
        questionDetected: anchors.length,
        questionExpected: questionCount,
        choiceDetected: choiceStats.detected,
        choiceExpected: choiceStats.expected,
        choiceCoverage: choiceStats.coverage,
        choiceMissingQuestions: choiceStats.missingQuestions,
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
