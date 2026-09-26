// 장소 담기 상태 (UI-S2-036~043). 순수 리듀서라 화면과 따로 시험한다. 종류 · 정렬 · 카드
// 펼침 · 이미 넣은 곳을 담는다. 칩 · 정렬 · 펼침을 눌러도 일정은 바뀌지 않는다 — 일정은
// [일정에 넣기]로만 바뀐다 (FR-PL-016).
//
// 근처 3km(앵커) · 필터는 B8-② 에서 더한다.

export type PickerSort = "near" | "together";
export type NearKind = "MEAL" | "CAFE" | "STAY";
export interface PickerFilters {
  wheelchair: boolean;
  pet: boolean;
  indoor: boolean;
}

export interface PickerState {
  /** 고른 종류(중분류). null = 아직 안 고름 */
  lcls2: string | null;
  /** 근처 3km 종류(식당 · 카페 · 숙소). lcls2 와 배타적이다 */
  nearKind: NearKind | null;
  sort: PickerSort;
  filters: PickerFilters;
  /** 넣을 위치 = 근처 3km 의 앵커가 되는 항목. null 이면 3km 칩은 꺼진다 */
  anchorItemId: number | null;
  /** [자세히]로 펼친 카드의 contentId */
  expandedId: string | null;
  /** 이미 일정에 넣은 곳 (contentId). "일정에 있음" 표시에 쓴다 */
  inserted: string[];
}

export type PickerAction =
  | { type: "SELECT_TYPE"; lcls2: string }
  | { type: "SELECT_NEAR"; nearKind: NearKind }
  | { type: "SET_SORT"; sort: PickerSort }
  | { type: "SET_ANCHOR"; anchorItemId: number | null }
  | { type: "TOGGLE_FILTER"; key: keyof PickerFilters }
  | { type: "CLEAR_FILTERS" }
  | { type: "TOGGLE_EXPAND"; contentId: string }
  | { type: "MARK_INSERTED"; contentId: string };

export const initialPickerState: PickerState = {
  lcls2: null,
  nearKind: null,
  sort: "near",
  filters: { wheelchair: false, pet: false, indoor: false },
  anchorItemId: null,
  expandedId: null,
  inserted: [],
};

/**
 * "자주 넣는 곳" 칩에서 넘어온 종류로 장소 담기를 열 때의 초기 상태 (UI-S2-030). openType 이
 * 있으면 그 중분류를 골라 둔 채로 시작한다 — 없으면 아무 것도 안 고른 기본 상태.
 */
export function pickerStateWith(openType: string | null): PickerState {
  return openType === null || openType === "" ? initialPickerState : { ...initialPickerState, lcls2: openType };
}

export function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "SELECT_TYPE":
      // 종류를 바꿔도 넣은 목록은 그대로다 (칩은 넣기를 바꾸지 않는다). 근처 3km 와 배타적
      return { ...state, lcls2: action.lcls2, nearKind: null, expandedId: null };
    case "SELECT_NEAR":
      return { ...state, nearKind: action.nearKind, lcls2: null, expandedId: null };
    case "SET_SORT":
      return { ...state, sort: action.sort };
    case "SET_ANCHOR":
      // 넣을 위치를 옮기면 근처 3km 를 다시 열어야 한다 — 열린 3km 칩을 닫는다
      return { ...state, anchorItemId: action.anchorItemId, nearKind: state.nearKind !== null ? null : state.nearKind };
    case "TOGGLE_FILTER":
      return { ...state, filters: { ...state.filters, [action.key]: !state.filters[action.key] } };
    case "CLEAR_FILTERS":
      // 「필터 끄기」 · 「필터 모두 끄기」 (UI-S2-038). 종류 · 정렬 · 넣을 위치는 그대로 둔다
      return { ...state, filters: { ...initialPickerState.filters } };
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
