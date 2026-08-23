import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * apps/api 린트 설정.
 *
 * 일반 코드 품질보다 **설계 제약을 기계가 강제하게 만드는 것**이 이 설정의 목적이다.
 * 규칙엔진의 결정론성(NF-MT-001)과 어댑터 격리(NF-MT-003)는 사람이 리뷰로 지키기엔
 * 너무 조용히 깨진다 — 규칙 클래스에서 외부 호출 한 줄, `new Date()` 한 줄이면
 * 같은 입력에 다른 판정이 나오고, 그 사실은 회귀 테스트가 실패할 때까지 드러나지 않는다.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // 공사 응답 본문이 로그로 새는 것을 막는 1차 방어선 (DB 명세서 6-4 누출 경로 ①).
      // 의도적인 출력은 파일 단위로 eslint-disable 을 달아 흔적을 남긴다.
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // ── 규칙엔진 격리 경계 ──────────────────────────────────────
    // rule 패키지는 external 패키지를 의존하지 않는다. 판정에 필요한 데이터는
    // AuditRunner 가 미리 모아 ItineraryContext 로 넘긴다 (API 설계 2-2 · 6-3).
    files: ['src/engine/rules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/external/**', '**/external', '@tourlint/*/external/**'],
              message:
                '규칙은 external 어댑터를 직접 호출할 수 없다. 필요한 값은 ItineraryContext 로 받는다 (NF-MT-003 · API 설계 6-3).',
            },
            {
              group: ['**/*.repository', '**/*.repository.ts', '**/repository/**',
            '**/persistence/**'],
              message:
                '규칙 평가는 메모리 상에서만 수행한다. DB 조회가 필요하면 AuditRunner 가 미리 조립한다 (NF-PF-014).',
            },
          ],
        },
      ],
      // evaluate() 는 순수 함수여야 한다. ItineraryContext 외의 입력(시계·난수)을 금지한다.
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            '규칙 평가에 현재 시각을 쓰면 같은 입력에 다른 판정이 나온다. 기준일·기준시각은 ItineraryContext 로 받는다 (NF-MT-001).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '규칙 평가는 결정론적이어야 한다 (NF-MT-001).',
        },
        {
          object: 'Date',
          property: 'now',
          message: '기준 시각은 ItineraryContext 로 받는다 (NF-MT-001).',
        },
      ],
    },
  },

  {
    // ── 임시 목업 ───────────────────────────────────────────────
    // src/mock 은 실엔진 완성 전까지만 존재하는 코드다. W1~W3 에 도메인 모듈로
    // 엔드포인트 단위 교체하고 교체가 끝나면 즉시 삭제한다(FR-OP-009 · NF-CO-002).
    // 곧 지울 코드에 타입을 붙이는 대신 여기서 예외를 명시하고, 이 블록이 남아 있는 것
    // 자체를 "아직 목업이 남아 있다"는 신호로 쓴다.
    files: ['src/mock/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // 테스트는 위 제약의 적용 대상이 아니다 — 오히려 제약을 검증하는 쪽이다.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
