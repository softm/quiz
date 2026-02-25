import { promises as fs } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const outFile = path.join(rootDir, 'data', 'exams.json');
const outJsFile = path.join(rootDir, 'data', 'exams.manifest.js');

const categories = [
  '농산물품질관리사',
  '시설원예기사',
  '유기농업기사',
];
const categorySlugMap = {
  '농산물품질관리사': 'qcm',
  '시설원예기사': 'gh',
  '유기농업기사': 'org',
};

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join('/');
}

function parsePdfName(fileName) {
  const normalized = fileName.normalize('NFC');
  const base = normalized.replace(/\.pdf$/i, '').trim();
  const match = base.match(/^(.*?)(?:\s*)(시험문제지|최종정답)$/);
  if (!match) return null;

  const examName = match[1].trim();
  const kind = match[2] === '시험문제지' ? 'question' : 'answer';

  if (!examName) return null;
  return { examName, kind };
}

function parseExamMeta(examName) {
  const normalized = examName.normalize('NFC');
  const m = normalized.match(/(\d{4})년\s*제\s*(\d+)회.*?(\d+)차/);
  if (!m) return null;
  return {
    year: m[1],
    round: String(Number(m[2])),
    stage: String(Number(m[3])),
  };
}

async function ensureAliasPdf(categoryName, sourceName, parsed) {
  const categoryDir = path.join(rootDir, categoryName);
  const sourcePath = path.join(categoryDir, sourceName);
  const meta = parseExamMeta(parsed.examName);
  const slug = categorySlugMap[categoryName] || 'quiz';

  let aliasName;
  if (meta) {
    aliasName = `${slug}_${meta.year}_${meta.round}_${meta.stage}_${parsed.kind}.pdf`;
  } else {
    const safeExam = parsed.examName
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_]/g, '');
    aliasName = `${slug}_${safeExam || 'exam'}_${parsed.kind}.pdf`;
  }

  const aliasPath = path.join(categoryDir, aliasName);
  if (path.basename(sourcePath) !== aliasName) {
    await fs.copyFile(sourcePath, aliasPath);
  }
  return toPosixPath(path.join(categoryName, aliasName));
}

async function readCategory(categoryName) {
  const categoryDir = path.join(rootDir, categoryName);
  let dirEntries = [];

  try {
    dirEntries = await fs.readdir(categoryDir, { withFileTypes: true });
  } catch {
    return {
      categoryName,
      directory: categoryName,
      exams: [],
    };
  }

  const examMap = new Map();

  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.pdf')) continue;

    const parsed = parsePdfName(entry.name);
    if (!parsed) continue;

    const relPath = await ensureAliasPdf(categoryName, entry.name, parsed);
    const key = parsed.examName;

    if (!examMap.has(key)) {
      examMap.set(key, {
        examName: parsed.examName,
        questionPdf: null,
        answerPdf: null,
      });
    }

    const exam = examMap.get(key);
    if (parsed.kind === 'question') exam.questionPdf = relPath;
    if (parsed.kind === 'answer') exam.answerPdf = relPath;
  }

  const exams = Array.from(examMap.values())
    .sort((a, b) => b.examName.localeCompare(a.examName, 'ko'));

  return {
    categoryName,
    directory: categoryName,
    exams,
  };
}

async function main() {
  const data = {
    generatedAt: new Date().toISOString(),
    categories: [],
  };

  for (const categoryName of categories) {
    data.categories.push(await readCategory(categoryName));
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(data, null, 2), 'utf8');
  await fs.writeFile(
    outJsFile,
    `window.__EXAMS_MANIFEST__ = ${JSON.stringify(data, null, 2)};\n`,
    'utf8'
  );

  console.log(`Manifest created: ${path.relative(rootDir, outFile)}, ${path.relative(rootDir, outJsFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
