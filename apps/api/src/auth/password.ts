import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 비밀번호 해시 — scrypt.
 *
 * bcrypt 가 아니라 Node 내장 scrypt 를 쓴다. scrypt 는 메모리 하드 적응형 해시라
 * 단순 SHA 계열 단독 금지 요건을 충족하고 (NF-SC-003 · DR-PR-007), bcrypt 처럼
 * 네이티브 컴파일 의존성을 끌어오지 않아 pnpm · Node 22 빌드 함정에서 자유롭다.
 *
 * 저장 형식은 `scrypt$N$r$p$salt$hash` (salt · hash 는 base64). 파라미터를 문자열에
 * 함께 담아, 나중에 비용을 올려도 옛 해시를 그대로 검증할 수 있게 한다.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * 저장된 해시와 대조한다. 형식이 깨졌거나 길이가 안 맞으면 조용히 `false` —
 * 예외를 던지면 "이 계정은 해시가 이상하다" 는 신호가 새어 나간다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null) return false;
  const actual = await scrypt(password, parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  });
  if (actual.length !== parsed.hash.length) return false;
  return timingSafeEqual(actual, parsed.hash);
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  return { N, r, p, salt: Buffer.from(parts[4] ?? '', 'base64'), hash: Buffer.from(parts[5] ?? '', 'base64') };
}
