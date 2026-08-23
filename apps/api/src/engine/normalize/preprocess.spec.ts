import { describe, expect, it } from 'vitest';
import {
  MAX_FRAGMENT_LENGTH, extractParentheticals, normalizeLineBreaks, splitBlocks,
  splitFragments, splitNotes, stripFormatting, truncateFragment,
} from './preprocess';

describe('stripFormatting — 서식 기호를 턴다 (FR-AU-016)', () => {
  it.each([
    ['- 11:00~20:00', '11:00~20:00'],
    ['  • 입실 15:00', '입실 15:00'],
    ['　전각 공백', '전각 공백'],
    ['· 항목', '항목'],
  ])('%s → %s', (raw, e) => {
    expect(stripFormatting(raw)).toBe(e);
  });
});

describe('normalizeLineBreaks — `<br>` 은 실측 데이터다', () => {
  it.each(['<br>', '<br/>', '<BR>', '<br />'])('%s 를 개행으로 바꾼다', (tag) => {
    expect(normalizeLineBreaks(`앞${tag}뒤`)).toBe('앞\n뒤');
  });
});

describe('splitNotes — 본문과 `※` 안내를 가른다', () => {
  it('안내를 버리지 않는다 — 조건이 붙어 있을 수 있다', () => {
    expect(splitNotes('09:00~18:00※ 자세한 사항은 전화문의 요망')).toEqual({
      main: '09:00~18:00',
      notes: ['자세한 사항은 전화문의 요망'],
    });
  });

  it('안내만 있는 경우 본문은 빈 문자열이다', () => {
    expect(splitNotes('※ 점포 별로 상이함')).toEqual({ main: '', notes: ['점포 별로 상이함'] });
  });
});

describe('splitBlocks — `[...]` 라벨 경계 (FR-AU-015)', () => {
  it('실측 원문에는 개행이 없고 블록이 그대로 이어 붙는다', () => {
    expect(splitBlocks('[월요일]- 07:40~16:00[수요일~일요일]- 07:40~19:30')).toEqual([
      { label: '월요일', body: '07:40~16:00' },
      { label: '수요일~일요일', body: '07:40~19:30' },
    ]);
  });

  it('라벨 없는 선두 구간도 블록 하나로 만든다', () => {
    expect(splitBlocks('09:00~18:00 [야간]18:00~23:00')).toEqual([
      { label: null, body: '09:00~18:00' },
      { label: '야간', body: '18:00~23:00' },
    ]);
  });

  it('라벨이 없으면 블록 하나다', () => {
    expect(splitBlocks('09:00~18:00')).toEqual([{ label: null, body: '09:00~18:00' }]);
  });
});

describe('splitFragments — 조각 경계 (파싱규칙 §1)', () => {
  it('`- ` 은 항목 구분자다 — 실측 45건이 이 형태다', () => {
    expect(splitFragments('11:00~20:00- 준비시간 15:30~17:00- 마지막 주문 19:30')).toEqual([
      '11:00~20:00', '준비시간 15:30~17:00', '마지막 주문 19:30',
    ]);
  });

  it('시각 범위의 하이픈은 자르지 않는다 — ` - ` 형태는 287건 어디에도 없다', () => {
    expect(splitFragments('10:00-20:00')).toEqual(['10:00-20:00']);
  });

  it.each([['a/b', ['a', 'b']], ['a,b', ['a', 'b']], ['a·b', ['a', 'b']], ['a\nb', ['a', 'b']]])(
    '%s 를 자른다', (raw, e) => { expect(splitFragments(raw)).toEqual(e); },
  );

  it('괄호 안은 자르지 않는다 — 한 덩어리다', () => {
    expect(splitFragments('10:00~20:00 (쉬는시간 15:00~17:00 / 마지막 주문 19:30)')).toEqual([
      '10:00~20:00 (쉬는시간 15:00~17:00 / 마지막 주문 19:30)',
    ]);
  });
});

describe('extractParentheticals', () => {
  it('괄호를 뽑고 나머지를 돌려준다', () => {
    expect(extractParentheticals('09:00~18:00 (입장 마감 17:30)')).toEqual({
      head: '09:00~18:00', parentheticals: ['입장 마감 17:30'],
    });
  });

  it('중첩 괄호는 통째로 하나다', () => {
    expect(extractParentheticals('연중무휴 (단, 기상특보(풍랑주의보) 발령 시 휴무)').parentheticals).toEqual([
      '단, 기상특보(풍랑주의보) 발령 시 휴무',
    ]);
  });

  it('닫히지 않은 괄호도 내용을 살린다', () => {
    expect(extractParentheticals('09:00~18:00 (입장 마감 17:30').parentheticals).toEqual(['입장 마감 17:30']);
  });

  it('괄호가 없으면 그대로다', () => {
    expect(extractParentheticals('09:00~18:00')).toEqual({ head: '09:00~18:00', parentheticals: [] });
  });
});

describe('truncateFragment — 원문 전문을 복사하지 않는다 (DR-NM-014 · DR-PR-003)', () => {
  it('200자를 넘으면 앞 200자로 자른다', () => {
    expect(truncateFragment('가'.repeat(300))).toHaveLength(MAX_FRAGMENT_LENGTH);
    expect(truncateFragment('짧다')).toBe('짧다');
  });
});
