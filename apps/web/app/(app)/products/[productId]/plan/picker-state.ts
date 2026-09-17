// 장소 담기 상태 (UI-S2-036~043). 순수 리듀서라 화면과 따로 시험한다. 종류 · 정렬 · 카드
// 펼침 · 이미 넣은 곳을 담는다. 칩 · 정렬 · 펼침을 눌러도 일정은 바뀌지 않는다 — 일정은
// [일정에 넣기]로만 바뀐다 (FR-PL-016).
//
// 근처 3km(앵커) · 필터는 B8-② 에서 더한다.

export type PickerSort = "near" | "together";

export interface PickerState {
  /** 고른 종류(중분류). null = 아직 안 고름 */
  lcls2: string | null;
  sort: PickerSort;
  /** [자세히]로 펼친 카드의 contentId */
  expandedId: string | null;
  /** 이미 일정에 넣은 곳 (contentId). "일정에 있음" 표시에 쓴다 */
  inserted: string[];
}

export type PickerAction =
  | { type: "SELECT_TYPE"; lcls2: string }
  | { type: "SET_SORT"; sort: PickerSort }
  | { type: "TOGGLE_EXPAND"; contentId: string }
  | { type: "MARK_INSERTED"; contentId: string };

export const initialPickerState: PickerState = {
  lcls2: null,
  sort: "near",
  expandedId: null,
  inserted: [],
};

export function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "SELECT_TYPE":
      // 종류를 바꿔도 넣은 목록은 그대로다 (칩은 넣기를 바꾸지 않는다)
      return { ...state, lcls2: action.lcls2, expandedId: null };
    case "SET_SORT":
      return { ...state, sort: action.sort };
    case "TOGGLE_EXPAND":
      return { ...state, expandedId: state.expandedId === action.contentId ? null : action.contentId };
    case "MARK_INSERTED":
      return state.inserted.includes(action.contentId)
        ? state
        : { ...state, inserted: [...state.inserted, action.contentId] };
    default:
      return state;
  }
}

export function isInserted(state: PickerState, contentId: string): boolean {
  return state.inserted.includes(contentId);
}
