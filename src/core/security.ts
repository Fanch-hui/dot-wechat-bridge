const encoder = new TextEncoder();
function base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function bytes(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function token() { return base64(crypto.getRandomValues(new Uint8Array(32))); }
export async function hash(value: string) {
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
export function equal(a: string, b: string) {
  const left = encoder.encode(a), right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}
export class Vault {
  private readonly key: Promise<CryptoKey>;
  constructor(key: string | undefined) {
    if (!key || bytes(key).byteLength !== 32) throw new Error("missing_data_key");
    this.key = crypto.subtle.importKey("raw", bytes(key), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async seal(value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = encoder.encode(JSON.stringify(value));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv}, await this.key, data));
    return `${base64(iv)}.${base64(cipher)}`;
  }
  async open<T>(value: string): Promise<T> {
    const [iv, cipher] = value.split(".");
    const plain = await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(iv)}, await this.key, bytes(cipher));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }
}
