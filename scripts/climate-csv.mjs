/**
 * 평년 강수일수 CSV 해석 (EI-WX-004 · 이슈 #7).
 *
 * 부수효과가 없다 — 파일도 DB 도 건드리지 않는다. `seed_climate_normal.mjs` 가 이것을
 * 쓰고, 테스트가 같은 함수를 직접 부른다. 스크립트 안에 두면 실행 없이는 검증할 수 없다.
 */

/** 평년 30년(1991–2020)의 월 평균 일수. 2월은 윤년 7회를 반영한다 */
export const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 바이트를 문자열로. **인코딩을 가정하지 않는다.**
 *
 * 국내 포털 내려받기는 EUC-KR(CP949)로 오는 경우가 흔하다. UTF-8 로 읽으면 지점명이
 * 깨지는 데서 그치지 않고 머리글의 「강수일수」를 못 찾아 「열이 없다」로 멈춘다 —
 * 원인이 인코딩인데 형식 문제로 보인다.
 */
export function decodeCsv(buf) {
  // xlsx 는 zip 이라 PK 로 시작한다. 깨진 글자를 보여 주는 것보다 무엇인지 말해 주는 게 낫다
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    throw new Error('엑셀(.xlsx) 파일이다. 포털에서 CSV 로 다시 받거나 파일을 그대로 넘길 것');
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return { text: utf8.replace(/^﻿/, ''), encoding: 'utf-8' };
  return { text: new TextDecoder('euc-kr').decode(buf).replace(/^﻿/, ''), encoding: 'euc-kr' };
}

/** 따옴표 안의 쉼표를 구분자로 보지 않는다 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * 머리글에서 열 위치를 찾는다. 포털 내려받기마다 이름이 달라 후보를 여럿 본다.
 *
 * **못 찾으면 던진다.** 조용히 넘기면 그 열이 0 으로 들어가고, 강수확률 0% 는 R09 에서
 * 「비 안 옴」이라 비 오는 날이 전부 정상 판정된다.
 */
export function findColumn(header, candidates, label) {
  for (let i = 0; i < header.length; i++) {
    const cell = header[i].replace(/\s|\(|\)/g, '');
    if (candidates.some((c) => cell.includes(c))) return i;
  }
  throw new Error(
    `CSV 에서 '${label}' 열을 못 찾았다. 머리글: ${header.join(' | ')}\n` +
    `  찾은 이름 후보: ${candidates.join(' · ')}\n` +
    `  scripts/climate-csv.mjs 의 후보 목록에 실제 열 이름을 추가할 것`,
  );
}

const STN_NAMES = ['지점번호', '지점코드', 'stnId', '지점'];
const MONTH_NAMES = ['월', 'month'];
const RAIN_DAY_NAMES = ['강수일수', '강수계속일수', 'rainDay'];

/**
 * CSV 문자열 → 시드 행.
 *
 * `stationToSido` 는 지점번호 → 그 지점을 대표로 쓰는 시도 목록이다. 한 지점이 여러
 * 시도를 대표하는 경우가 있다 — 강릉은 `42` 와 `51` 둘 다, 대전은 대전과 세종이다.
 */
export function parseClimateCsv(text, stationToSido) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  // 포털 파일은 앞에 주석 줄이 붙기도 한다. 지점 열이 보이는 첫 줄을 머리글로 본다
  const headerIndex = lines.findIndex((l) => /지점|stnId/i.test(l) && /월|month/i.test(l));
  if (headerIndex < 0) throw new Error('머리글 줄을 못 찾았다 (지점 · 월 열이 있는 줄이 없다)');

  const header = splitCsvLine(lines[headerIndex]);
  const stnCol = findColumn(header, STN_NAMES, '지점번호');
  const monthCol = findColumn(header, MONTH_NAMES, '월');
  const rainDayCol = findColumn(header, RAIN_DAY_NAMES, '강수일수');

  const rows = [];
  const seen = new Set();
  const skippedStations = new Set();

  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitCsvLine(line);
    const stnId = Number(cells[stnCol]);
    const month = Number(String(cells[monthCol] ?? '').replace(/[^0-9]/g, ''));
    const raw = cells[rainDayCol];

    const sidos = stationToSido.get(stnId);
    if (sidos === undefined) { skippedStations.add(cells[stnCol]); continue; }
    if (!(month >= 1 && month <= 12)) continue;

    /*
     * 대표로 쓰는 지점의 값을 못 읽었다. 0 으로 넣으면 비 오는 달이 정상으로 판정된다.
     *
     * 빈 칸을 특히 조심한다 — `Number('')` 은 0 이라 그냥 두면 결측이 「그 달에 비 온
     * 날이 하루도 없다」가 된다. 결측 표기가 `-` · `-9` 인 판도 있어 음수도 막는다.
     *
     * 0 도 받지 않는다. 국내 어느 지점 · 어느 달도 평년 강수일수가 0 인 곳은 없어서
     * (가장 적은 달이 4~5일) 0 이 나왔다면 결측을 0 으로 적은 파일이다.
     */
    const rainDays = raw === undefined || String(raw).trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(rainDays) || rainDays <= 0 || rainDays > 31) {
      throw new Error(`강수일수를 못 읽었다: 지점 ${stnId} ${month}월 → ${JSON.stringify(raw)}`);
    }

    const ratio = Math.min(1, rainDays / DAYS_IN_MONTH[month - 1]);
    for (const sido of sidos) {
      const key = `${sido}-${month}`;
      // 같은 시도를 두 지점이 대표할 수는 없다. 먼저 나온 줄을 쓴다
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ sido, month, rainDays, ratio: Number(ratio.toFixed(3)), stnId });
    }
  }

  return { rows, seen, skippedStations: [...skippedStations] };
}
