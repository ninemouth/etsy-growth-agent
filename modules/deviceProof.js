const INSTALLATION_KEY = "marqelInstallationKey";

function storageGet(store, keys) {
  return new Promise((resolve) => store.get(keys, resolve));
}

function storageSet(store, value) {
  return new Promise((resolve) => store.set(value, resolve));
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function keyId(publicKey) {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", fromBase64Url(publicKey))).slice(0, 32);
}

export async function getInstallationIdentity() {
  const stored = await storageGet(chrome.storage.local, [INSTALLATION_KEY]);
  const current = stored[INSTALLATION_KEY];
  if (current?.publicKey && current?.privateKey && current?.keyId) return current;
  if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID) throw new Error("当前浏览器不支持 Marqel 安装密钥，请更新 Chrome 后重试。");
  const pair = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = toBase64Url(await globalThis.crypto.subtle.exportKey("spki", pair.publicKey));
  const privateKey = toBase64Url(await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const identity = { publicKey, privateKey, keyId: await keyId(publicKey), createdAt: new Date().toISOString() };
  await storageSet(chrome.storage.local, { [INSTALLATION_KEY]: identity });
  return identity;
}

export async function createDeviceProof(method, pathname) {
  const identity = await getInstallationIdentity();
  const timestamp = Date.now();
  const jti = globalThis.crypto.randomUUID();
  const message = `${String(method || "").toUpperCase()}\n${String(pathname || "")}\n${timestamp}\n${jti}`;
  const privateKey = await globalThis.crypto.subtle.importKey("pkcs8", fromBase64Url(identity.privateKey), { name: "Ed25519" }, false, ["sign"]);
  const signature = await globalThis.crypto.subtle.sign({ name: "Ed25519" }, privateKey, new globalThis.TextEncoder().encode(message));
  return { keyId: identity.keyId, timestamp, jti, signature: toBase64Url(signature) };
}

export function encodeDeviceProof(proof) {
  return toBase64Url(new globalThis.TextEncoder().encode(JSON.stringify(proof)));
}
