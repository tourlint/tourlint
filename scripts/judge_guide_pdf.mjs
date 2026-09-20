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

function image(rel) {
  const path = join(ROOT, 'docs/judge-guide', rel);
  if (!existsSync(path)) return;
  // 남은 높이에 안 들어가면 다음 장으로. 캡처가 잘려 나가면 읽을 수 없다
  const room = doc.page.height - MARGIN - doc.y;
  if (room < 160) doc.addPage();
  doc.image(path, MARGIN, doc.y, { fit: [WIDTH, doc.page.height - MARGIN - doc.y - 10] });
  doc.y += Math.min(doc.page.height - MARGIN - doc.y - 10, 300) + 10;
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
