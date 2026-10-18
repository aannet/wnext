const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID (26 car., Crockford). `rand` injectable pour des tests/simulations déterministes. */
export function ulid(now = Date.now(), rand: () => number = Math.random): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = "";
  for (let i = 0; i < 16; i++) r += ALPHABET[Math.floor(rand() * 32)];
  return time + r;
}
