#!/usr/bin/env node
/* SOFTM-OCR 시작: ocrmypdf 후처리 지연 시에도 OCR PDF를 생성하는 fallback 파이프라인 - 2026-05-30 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const [inputAbs, outputAbs] = process.argv.slice(2);
const root = process.cwd();
const dpi = Number(process.env.QUIZ_OCR_DPI || 300); // SOFTM-OCR: 직접 텍스트 레이어 방식의 OCR 품질 확보를 위해 기본 렌더링 해상도 상향 - 2026-05-30
const psm = String(process.env.QUIZ_OCR_PSM || "4"); // SOFTM-OCR: 한국어 문제지는 단락 기반 PSM이 본문 OCR 품질이 높아 기본값을 조정 - 2026-05-30
const language = String(process.env.QUIZ_OCR_LANG || "kor"); // SOFTM-OCR: 한국어 시험지 본문 오인식을 줄이도록 fallback OCR 기본 언어를 한국어 우선으로 조정 - 2026-05-30
const tessdataDir = String(process.env.QUIZ_OCR_TESSDATA_DIR || "");

if (!inputAbs || !outputAbs) {
  console.error("usage: node scripts/ocr-fallback.mjs <input.pdf> <output.pdf>");
  process.exit(2);
}

function run(command, args){
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with code ${code ?? "-"}${signal ? `, signal ${signal}` : ""}`));
    });
  });
}

async function main(){
  const workRoot = path.join(root, ".ocr-work");
  await fsp.mkdir(workRoot, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(workRoot, "fallback-"));
  const outputDir = path.dirname(outputAbs);
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.rm(outputAbs, { force: true });

  try{
    const prefix = path.join(tempDir, "page");
    console.log(`FALLBACK render dpi=${dpi} psm=${psm} lang=${language}`);
    await run("pdftoppm", ["-r", String(dpi), "-png", inputAbs, prefix]);
    const images = (await fsp.readdir(tempDir))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map((name) => path.join(tempDir, name));
    if (!images.length) throw new Error("pdftoppm output image not found");
    console.log(`FALLBACK pages ${images.length}`);

    for (let i = 0; i < images.length; i += 1) {
      const base = path.join(tempDir, `ocr-${String(i + 1).padStart(4, "0")}`);
      console.log(`FALLBACK page ${i + 1}/${images.length}`);
      const tessArgs = tessdataDir ? ["--tessdata-dir", tessdataDir] : [];
      await run("tesseract", [...tessArgs, images[i], base, "-l", language, "--psm", psm, "txt", "hocr"]); // SOFTM-OCR: PDF 텍스트 레이어를 원문 좌표에 맞추도록 hOCR bbox도 함께 생성 - 2026-05-30
    }

    console.log("FALLBACK layer");
    await run("python3", [path.join(root, "scripts", "build-layered-ocr-pdf.py"), tempDir, outputAbs, "--dpi", String(dpi)]);
    const stat = fs.statSync(outputAbs);
    if (!stat.size) throw new Error("fallback OCR output is empty");
    console.log(`FALLBACK done ${outputAbs}`);
  }finally{
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
/* SOFTM-OCR 끝 */
