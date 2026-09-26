/**
 * 올린 파일이 이름대로의 형식인가 (NF-SC-006 · EX-IN-011).
 *
 * 확장자만 보던 때는 이름만 `.xlsx` 로 바꾼 PDF · 이미지가 엑셀 파서까지 가서 500 으로 끝났다.
 * 파서에 넘기기 전에 **내용의 첫 바이트**를 본다.
 *
 * MIME 은 브라우저 · 운영체제마다 다르게 붙는다 — 같은 `.csv` 가 `text/csv` · `application/vnd.ms-excel`
 * · `text/plain` · 빈 값으로 온다. 허용 목록으로 좁히면 멀쩡한 양식이 막힌다. 그래서 **엑셀 · CSV 가
 * 아닌 게 분명한 것만** 거절하고, 나머지는 내용으로 가른다.
 */

export type SheetKind = 'xlsx' | 'csv';

/** 확장자로 정한 종류. 둘 다 아니면 null */
export function sheetKindOf(filename: string): SheetKind | null {
  const name = filename.toLowerCase();
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.csv')) return 'csv';
  return null;
}

/** 엑셀 · CSV 일 수 없는 MIME. 이미지 · 소리 · 영상 · 글꼴 · PDF */
const CLEARLY_OTHER = /^(?:image|audio|video|font)\/|^application\/pdf$/i;

export function mimeClearlyOther(mime: string | undefined): boolean {
  return CLEARLY_OTHER.test((mime ?? '').trim());
}

/**
 * 내용이 그 종류로 보이는가.
 *
 * xlsx 는 ZIP 이라 `PK` 로 시작한다. CSV 는 글자라 NUL(0x00) 이 없다 — UTF-16 으로 저장한
 * 파일도 여기서 걸린다(글자마다 0x00 이 끼어 헤더를 못 찾는다).
 */
export function contentLooksLike(kind: SheetKind, buffer: Buffer): boolean {
  if (kind === 'xlsx') return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  return !buffer.includes(0);
}
