import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Argon2Params {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

function derive(password: string, salt: Buffer, p: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      { message: password, nonce: salt, memory: p.memoryKiB, passes: p.passes, parallelism: p.parallelism, tagLength },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

/** argon2id hash in PHC format: $argon2id$v=19$m=…,t=…,p=…$salt$hash */
export async function hashPassword(password: string, p: Argon2Params): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, p, 32);
  return `$argon2id$v=19$m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(key)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64');
  const key = await derive(
    password,
    Buffer.from(m[4]!, 'base64'),
    { memoryKiB: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) },
    expected.length,
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash used for unknown logins so that response time does not reveal whether a login exists. */
let dummy: Promise<string> | null = null;
export function dummyHash(p: Argon2Params): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-timing', p);
  return dummy;
}
