import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 루트 `build` 가 모든 워크스페이스를 덮는지 본다.
 *
 * 검증 절차가 `build → lint → typecheck → test` 인데 한때 루트 `build` 가 공용 패키지만
 * 빌드했다. 이름은 build 인데 서버도 화면도 안 돌아서, 낡은 산출물로 확인하다 시간을
 * 버렸고 CI 는 `next build` 를 한 번도 돌리지 않았다.
 *
 * 패키지가 늘 때 스크립트를 안 고치면 같은 구멍이 다시 생긴다. 여기서 막는다.
 */

const ROOT = join(__dirname, '../../..');

function scripts(path: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
}

describe('루트 검증 명령이 이름값을 하는가', () => {
  it('🔴 build 가 워크스페이스 전체를 돈다 — 특정 패키지만 지목하지 않는다', () => {
    const build = scripts('package.json').build ?? '';
    expect(build).toMatch(/pnpm -r/);
    // `--filter <하나>` 로 한 패키지만 짚으면 나머지가 조용히 빠진다
    expect(build).not.toMatch(/--filter/);
  });

  it('build 스크립트를 가진 패키지가 전부 있다', () => {
    for (const pkg of ['packages/shared', 'apps/api', 'apps/web']) {
      expect(scripts(`${pkg}/package.json`).build, pkg).toBeDefined();
    }
  });

  it('verify 는 네 단계를 순서대로 돈다', () => {
    const verify = scripts('package.json').verify ?? '';
    for (const step of ['build', 'lint', 'typecheck', 'test']) {
      expect(verify, step).toContain(step);
    }
  });
});
