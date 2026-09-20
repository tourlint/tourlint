#!/usr/bin/env node
// 심사위원 체험 가이드를 PDF 로 낸다 (#609).
//
// 노션 공개 페이지와 같은 내용인 `docs/judge-guide/README.md` 를 그대로 읽어 만든다 —
// 노션 export 를 손으로 받아 올리면 가이드를 고칠 때마다 빠뜨린다. 가이드를 고치면
// 이 스크립트를 다시 돌려 `apps/web/public/judge-guide.pdf` 를 교체한다.
//
//   node scripts/judge_guide_pdf.mjs
//
// 폰트는 리포트 PDF 와 같은 것을 쓴다(한글). 화면 캡처는 폭에 맞춰 넣는다.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// pdfkit 은 apps/api 의 의존성이다. pnpm 은 패키지마다 따로 두므로 거기서 찾는다
const PDFDocument = createRequire(join(ROOT, 'apps/api/package.json'))('pdfkit');
const GUIDE = join(ROOT, 'docs/judge-guide/README.md');
const OUT = join(ROOT, 'apps/web/public/judge-guide.pdf');
const FONT = join(ROOT, 'apps/api/assets/fonts/GothicA1-Regular.ttf');
const FONT_BOLD = join(ROOT, 'apps/api/assets/fonts/GothicA1-Bold.ttf');

const MARGIN = 48;
const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: 'TourLint 심사위원 체험 가이드' } });
doc.registerFont('body', FONT);
doc.registerFont('bold', FONT_BOLD);
mkdirSync(dirname(OUT), { recursive: true });
doc.pipe(createWriteStream(OUT));

const WIDTH = doc.page.width - MARGIN * 2;
/** 링크 · 강조 표기를 걷어 읽을 수 있는 글자만 남긴다. PDF 는 마크다운을 모른다 */
const plain = (s) => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\\([\[\]~*])/g, '$1')
  .trim();

function text(s, { size = 10, font = 'body', gap = 4, color = '#111111', indent = 0 } = {}) {
  if (doc.y > doc.page.height - MARGIN - size * 2) doc.addPage();
  doc.font(font).fontSize(size).fillColor(color)
    .text(s, MARGIN + indent, doc.y, { width: WIDTH - indent, lineGap: 2 });
  doc.y += gap;
}

// 캡처 최대 높이. 폭을 다 쓰면 1280×860 이 335pt 라 한 장을 거의 먹고 뒤가 빈다. 250 으로
// 묶어 설명 바로 아래에 붙는 크기로 낮춘다. 자리가 이보다 좁으면 그 자리에 맞춰 더 줄인다.
const IMG_MAX_H = 250;
const IMG_MIN_H = 140; // 이만큼도 안 남았을 때만 다음 장으로 (아래 공백을 최소화)
function image(rel) {
  const path = join(ROOT, 'docs/judge-guide', rel);
  if (!existsSync(path)) return;
  const img = doc.openImage(path);
  // 남은 자리가 너무 좁을 때만 다음 장으로 넘긴다. 예전엔 폭 맞춤 높이(335)가 안 들어가면
  // 무조건 넘겨 하단이 크게 비었다 — 이제 남은 자리를 채우도록 줄여 공백을 없앤다.
  const room = () => doc.page.height - MARGIN - doc.y - 8;
  if (room() < IMG_MIN_H) doc.addPage();
  // 폭 · 남은 높이 · 최대 높이 셋 중 가장 작은 배율. 확대는 안 한다.
  // pdfkit 은 image 뒤 doc.y 를 옮기지 않으므로 **그려진 높이**만큼 직접 내려 겹침을 막는다.
  const scale = Math.min(WIDTH / img.width, Math.min(room(), IMG_MAX_H) / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  doc.image(path, MARGIN + (WIDTH - w) / 2, doc.y, { width: w, height: h }); // 가운데 정렬
  doc.y += h + 8;
}

const lines = readFileSync(GUIDE, 'utf8').split('\n');
let inFence = false;
let tableRow = 0;
for (const raw of lines) {
  const line = raw.trimEnd();
  if (line.startsWith('```')) { inFence = !inFence; continue; }
  if (inFence) { text(line, { size: 8.5, color: '#444444', gap: 0 }); continue; }
  // 인용문 사이의 빈 `>` 줄은 화살표만 남아 문장처럼 보인다
  if (line.trim() === '' || line.trim() === '>') { tableRow = 0; doc.y += 4; continue; }

  const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
  if (img) { image(img[2]); continue; }

  if (line.startsWith('# ')) { text(plain(line.slice(2)), { size: 18, font: 'bold', gap: 10 }); continue; }
  if (line.startsWith('## ')) {
    if (doc.y > doc.page.height - MARGIN - 120) doc.addPage();
    text(plain(line.slice(3)), { size: 14, font: 'bold', gap: 8 });
    continue;
  }
  if (line.startsWith('### ')) { text(plain(line.slice(4)), { size: 11.5, font: 'bold', gap: 6 }); continue; }
  if (line.startsWith('> ')) { text(plain(line.slice(2)), { size: 9.5, color: '#555555', indent: 12 }); continue; }
  if (/^\s*[-*] /.test(line)) { text(`• ${plain(line.replace(/^\s*[-*] /, ''))}`, { indent: 10 }); continue; }
  if (/^\s*\d+\. /.test(line)) { text(plain(line), { indent: 10 }); continue; }
  if (line.startsWith('|')) {
    tableRow += 1;
    // 구분선(|---|)은 읽을 것이 없다
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => plain(c));
    text(cells.join('  ·  '), { size: 9, font: tableRow === 1 ? 'bold' : 'body', gap: 2, indent: 6 });
    continue;
  }
  if (line.startsWith('---')) { doc.y += 6; continue; }
  text(plain(line));
}

doc.end();
console.log(`wrote ${OUT}`);
