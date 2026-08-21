import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // 검수 엔진은 결정론적이어야 한다 (NF-MT-001).
    // 테스트가 순서에 의존하면 그 자체가 결함이므로 파일 단위 격리를 유지한다.
    isolate: true,
  },
});
