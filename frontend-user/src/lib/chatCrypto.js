/**
 * Encrypt / decrypt chat session history stored in localStorage.
 *
 * Each user gets their own AES-GCM key derived from their JWT token.
 * This keeps chat history isolated per-account and encrypted at rest
 * in the browser.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function deriveKey(token) {
  const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptSessions(sessions, token) {
  if (!token) return null;
  const key = await deriveKey(token);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(sessions));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return arrayBufferToBase64(combined);
}

export async function decryptSessions(cipherText, token) {
  if (!token || !cipherText) return null;
  try {
    const key = await deriveKey(token);
    const combined = new Uint8Array(base64ToArrayBuffer(cipherText));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}
