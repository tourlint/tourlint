// 관심 키워드 편집 (FR-MO-059 · UI-S7-012). 순수 함수라 화면과 따로 시험한다.
// 빈 값 · 중복은 넣지 않고, 넣을 수 없는 이유를 문구로 돌려준다.

export const MAX_WATCH_KEYWORDS = 50;

export interface KeywordAddResult {
  list: string[];
  error: string | null;
}

export function addKeyword(list: readonly string[], raw: string): KeywordAddResult {
  const kw = raw.trim();
  if (kw === "") return { list: [...list], error: "키워드를 입력해 주세요." };
  if (list.includes(kw)) return { list: [...list], error: "이미 등록한 키워드예요." };
  if (list.length >= MAX_WATCH_KEYWORDS) {
    return { list: [...list], error: `키워드는 최대 ${MAX_WATCH_KEYWORDS}개까지 등록할 수 있어요.` };
  }
  return { list: [...list, kw], error: null };
}

export function removeKeyword(list: readonly string[], kw: string): string[] {
  return list.filter((k) => k !== kw);
}
