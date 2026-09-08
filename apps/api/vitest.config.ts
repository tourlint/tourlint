import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * ⚠️ **swc 로 변환한다. esbuild 로는 DI 배선을 검증할 수 없다.**
 *
 * vitest 의 기본 변환기(esbuild)는 `emitDecoratorMetadata` 를 지원하지 않는다. 그러면
 * Nest 가 생성자 파라미터 타입(`design:paramtypes`)을 못 읽어 **주입 해석을 아예 시도하지
 * 않고**, 주입 불가능한 의존을 넣어도 조용히 통과한다.
 *
 * 실제로 그 상태에서 `app-boot` 이 초록불인 채 배포가 부팅에서 죽었다 (이슈 #329).
 * `nest build`(tsc)는 메타데이터를 뽑으므로 실행과 테스트가 갈렸던 것이다.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // 검수 엔진은 결정론적이어야 한다 (NF-MT-001).
    // 테스트가 순서에 의존하면 그 자체가 결함이므로 파일 단위 격리를 유지한다.
    isolate: true,
  },
});
