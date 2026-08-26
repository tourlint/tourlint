/**
 * 평년 강수일수 CSV 해석 (EI-WX-004 · 이슈 #7).
 *
 * 기상자료개방포털 **기후통계분석 > 기상현상일수 > 강수일수 > 기간조회**의 CSV 내려받기를
 * 읽는다. 2026.08.26 에 실제로 받은 파일(`STCS_강수일수_MNH_*.csv`)의 형태에 맞췄다.
 *
 * ```
 * 강수일수
 * 지점/지역명 : 강릉
 *
 * 평균 강수일수
 * 연도,1월,2월,...,12월,연합계,순위
 * 1991,8.0,5.0,...,10.0,107.0,22
 * ...
 * 2020,11.0,6.0,...,1.0,109.0,19
 * 평균,6.2,5.7,8.8,8.9,9.1,10.8,16.0,16.4,11.8,7.8,7.3,4.6
 * ```
 *
 * **`평균` 행이 곧 평년값이다** — 조회 기간 30년의 누년평균. 그래서 기간이 1991~2020 이
 * 맞는지 확인하고, 아니면 던진다. 다른 기간의 평균을 평년값으로 저장하면 출처와 기준
 * 평년 표기가 거짓이 된다 (EI-WX-004).
 *
 * 뒤에 계절별 표와 일자별 관측값이 더 붙어 오는데 쓰지 않는다.
 *
 * 부수효과가 없다 — 파일도 DB 도 건드리지 않는다. 스크립트 안에 두면 실행해 봐야만
 * 검증되고, 그러면 되돌려서 빨간지 볼 수가 없다.
 */

/** 평년 30년(1991–2020)의 월 평균 일수. 2월은 윤년 7회를 반영한다 */
export const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 평년 기간. 이것과 다른 기간으로 뽑은 파일은 받지 않는다 */
export const NORMAL_FROM = 1991;
export const NORMAL_TO = 2020;

/**
 * 바이트를 문자열로. **인코딩을 가정하지 않는다.**
 *
 * 실제로 받은 파일이 EUC-KR 이었다. UTF-8 로 읽으면 지점명이 깨져 시도를 못 찾는데,
 * 그러면 「대표로 쓰지 않는 지점」으로 조용히 건너뛴다 — 빈 결과가 나오고 원인은 안 보인다.
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
 * 지점 블록 하나를 읽는다.
 *
 * 파일 하나에 지점이 여럿 담겨 올 수도 있어 블록 단위로 나눠 처리한다 — 지금 화면은
 * 한 번에 한 지점만 조회되지만, 나중에 합친 파일을 넘겨도 그대로 돈다.
 */
function parseBlock(lines, stationName) {
  const headerIdx = lines.findIndex((l) => /^연도\s*,\s*1월/.test(l));
  if (headerIdx < 0) {
    throw new Error(`'${stationName}' 블록에 「연도,1월,…」 머리글이 없다. 자료구분이 「월」인지 확인할 것`);
  }

  const years = [];
  let average = null;
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitCsvLine(line);
    const first = cells[0] ?? '';
    if (/^\d{4}$/.test(first)) { years.push(Number(first)); continue; }
    if (first === '평균') { average = cells.slice(1, 13); break; }
    if (first === '') continue;
    break;
  }

  if (average === null) {
    throw new Error(`'${stationName}' 블록에 「평균」 행이 없다. 그 행이 평년값이라 없으면 쓸 수 없다`);
  }

  /*
   * 「평균」은 조회한 기간의 평균일 뿐이다. 기간이 1991~2020 이 아니면 그건 평년값이
   * 아니라 우리가 낸 평균이고, 출처(기상청)와 기준 평년 표기가 거짓이 된다.
   */
  const from = Math.min(...years);
  const to = Math.max(...years);
  if (years.length === 0 || from !== NORMAL_FROM || to !== NORMAL_TO) {
    throw new Error(
      `'${stationName}' 조회 기간이 ${years.length === 0 ? '없다' : `${from}~${to}`} 다. ` +
      `평년값은 ${NORMAL_FROM}~${NORMAL_TO} 이어야 한다 (EI-WX-004)`,
    );
  }

  const monthly = average.map((raw, i) => {
    /*
     * 빈 칸을 특히 조심한다 — `Number('')` 은 0 이라 그냥 두면 결측이 「그 달에 비 온
     * 날이 하루도 없다」가 되고, 강수확률 0% 는 R09 에서 「비 안 옴」이다.
     * 국내 어느 지점 · 어느 달도 평년 강수일수가 0 인 곳은 없다.
     */
    const n = raw === undefined || String(raw).trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 31) {
      throw new Error(`'${stationName}' ${i + 1}월 평균 강수일수를 못 읽었다 → ${JSON.stringify(raw)}`);
    }
    return n;
  });
  if (monthly.length !== 12) {
    throw new Error(`'${stationName}' 「평균」 행에 12개월이 아니라 ${monthly.length}개 값이 있다`);
  }

  return { stationName, monthly, years: { from, to, count: years.length } };
}

/**
 * CSV 문자열 → 시드 행.
 *
 * `nameToSido` 는 지점명 → 그 지점을 대표로 쓰는 시도 목록이다. 한 지점이 여러 시도를
 * 대표하는 경우가 있다 — 강릉은 `42` 와 `51` 둘 다, 대전은 대전과 세종이다.
 */
export function parseClimateCsv(text, nameToSido) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // 「지점/지역명 : 강릉」 이 블록의 시작이다
  const marks = [];
  lines.forEach((l, i) => {
    const m = /^지점\/지역명\s*:\s*(.+?)\s*$/.exec(l);
    if (m !== null) marks.push({ i, name: m[1] });
  });
  if (marks.length === 0) {
    throw new Error('「지점/지역명 : …」 줄이 없다. 강수일수 기간조회 화면의 CSV 가 맞는지 확인할 것');
  }

  const rows = [];
  const seen = new Set();
  const blocks = [];
  const skippedStations = [];

  for (let b = 0; b < marks.length; b++) {
    const start = marks[b].i;
    const end = b + 1 < marks.length ? marks[b + 1].i : lines.length;
    const block = parseBlock(lines.slice(start, end), marks[b].name);
    blocks.push(block);

    const sidos = nameToSido.get(block.stationName);
    if (sidos === undefined) { skippedStations.push(block.stationName); continue; }

    for (let m = 0; m < 12; m++) {
      const rainDays = block.monthly[m];
      const ratio = Math.min(1, rainDays / DAYS_IN_MONTH[m]);
      for (const sido of sidos) {
        const key = `${sido}-${m + 1}`;
        // 같은 시도를 두 지점이 대표할 수는 없다. 먼저 나온 블록을 쓴다
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ sido, month: m + 1, rainDays, ratio: Number(ratio.toFixed(3)), stationName: block.stationName });
      }
    }
  }

  return { rows, seen, blocks, skippedStations };
}
