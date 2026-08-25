import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('비밀번호 해시 (scrypt)', () => {
  it('해시한 비밀번호를 같은 값으로 검증하면 통과한다', async () => {
    const hash = await hashPassword('2026openapi!');
    expect(await verifyPassword('2026openapi!', hash)).toBe(true);
  });

  it('틀린 비밀번호는 통과하지 못한다', async () => {
    const hash = await hashPassword('2026openapi!');
    expect(await verifyPassword('2026openapi?', hash)).toBe(false);
  });

  it('같은 비밀번호도 salt 가 달라 매번 다른 해시가 나온다', async () => {
    const a = await hashPassword('samepassword');
    const b = await hashPassword('samepassword');
    expect(a).not.toEqual(b);
    // 그래도 둘 다 원문으로 검증된다
    expect(await verifyPassword('samepassword', a)).toBe(true);
    expect(await verifyPassword('samepassword', b)).toBe(true);
  });

  it('저장 형식은 scrypt 파라미터를 담는다 — 단순 SHA 가 아니다 (NF-SC-003)', async () => {
    const hash = await hashPassword('anything-goes');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('형식이 깨진 저장값은 예외 없이 false 를 준다', async () => {
    for (const bad of ['', 'plaintext', 'scrypt$only$three', 'sha256$x$y$z$w']) {
      expect(await verifyPassword('whatever', bad)).toBe(false);
    }
  });
});
