// Times argon2id for several parameter sets; pick one giving 0.3-0.5 s and set KOMAFLOW_ARGON2_* env vars.
import { argon2 } from 'node:crypto';

const run = (memory, passes) =>
  new Promise((res, rej) => {
    const t = performance.now();
    argon2('argon2id', { message: 'password', nonce: Buffer.alloc(16, 1), memory, passes, parallelism: 1, tagLength: 32 }, (e) =>
      e ? rej(e) : res(performance.now() - t),
    );
  });

for (const [m, t] of [
  [19456, 2],
  [32768, 3],
  [65536, 2],
  [65536, 3],
  [65536, 4],
]) {
  const times = [];
  for (let i = 0; i < 3; i++) times.push(await run(m, t));
  console.log(`argon2id m=${m} KiB t=${t}: ${times.map((x) => x.toFixed(0)).join(' / ')} ms`);
}
