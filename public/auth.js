import { config } from "./config.js";

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const STORAGE_KEY = "football-manager:auth";
const EXPIRY_MARGIN_MS = 60 * 1000;
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

let googleId = null;
let session = null;
let loadingScript = null;
/** @type {Set<() => void>} */
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(session);
}

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSession() {
  return session;
}

export function getToken() {
  return session?.token ?? null;
}

export function decodeIdToken(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function toSession(token) {
  try {
    const claims = decodeIdToken(token);
    const expiresAt = claims.exp * 1000;
    if (expiresAt - EXPIRY_MARGIN_MS <= Date.now()) return null;
    return {
      token,
      expiresAt,
      user: {
        id: claims.sub,
        name: claims.name,
        email: claims.email,
        picture: claims.picture,
      },
    };
  } catch {
    return null;
  }
}

function persist(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function restore() {
  try {
    const token = localStorage.getItem(STORAGE_KEY);
    return token ? toSession(token) : null;
  } catch {
    return null;
  }
}

function loadGoogleIdentity() {
  loadingScript ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve(window.google.accounts.id);
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(window.google.accounts.id);
    script.onerror = () => {
      loadingScript = null;
      script.remove();
      reject(new Error("Could not load Google sign-in"));
    };
    document.head.append(script);
  });
  return loadingScript;
}

let refreshTimer = null;
let expireTimer = null;

function scheduleTokenLifecycle() {
  clearTimeout(refreshTimer);
  clearTimeout(expireTimer);
  if (!session || !googleId) return;
  const now = Date.now();
  refreshTimer = setTimeout(
    () => googleId.prompt(),
    Math.max(0, session.expiresAt - REFRESH_BEFORE_MS - now)
  );
  expireTimer = setTimeout(() => {
    signOut();
  }, Math.max(0, session.expiresAt - EXPIRY_MARGIN_MS - now));
}

function acceptCredential(credential) {
  const next = toSession(credential);
  if (!next) return false;
  persist(credential);
  session = next;
  notify();
  scheduleTokenLifecycle();
  return true;
}

export function signOut() {
  googleId?.disableAutoSelect();
  persist(null);
  session = null;
  clearTimeout(refreshTimer);
  clearTimeout(expireTimer);
  notify();
}

export async function initAuth({ buttonEl, onError } = {}) {
  session = restore();
  if (session) {
    notify();
  }

  try {
    googleId = await loadGoogleIdentity();
    googleId.initialize({
      client_id: config.googleClientId,
      auto_select: true,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
      callback: ({ credential }) => {
        if (!acceptCredential(credential)) {
          onError?.("Google returned an expired sign-in. Please try again.");
        }
      },
    });
    if (buttonEl) {
      buttonEl.replaceChildren();
      googleId.renderButton(buttonEl, {
        theme: "filled_black",
        size: "large",
        text: "signin_with",
        shape: "pill",
      });
    }
    if (!session) googleId.prompt();
    else scheduleTokenLifecycle();
  } catch (err) {
    onError?.(err.message || String(err));
  }

  return session;
}
