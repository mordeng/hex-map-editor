// Client-side Steam session handling for the editor.
//
// The editor is a static site on a different origin than the wtd-analytics API,
// so it can't use an HttpOnly cookie. Instead, after "Sign in through Steam" the
// backend redirects back with the signed token in the URL fragment (#token=...).
// We stash it in localStorage and replay it as `Authorization: Bearer <token>`.
// The token is only *read* here (for display); the server re-verifies its HMAC
// on every request, so a tampered payload buys nothing.

const STORAGE_KEY = 'wtd_session';

export interface SteamSession {
  steamId: string;
  name: string;
  avatar?: string;
  exp: number; // epoch ms
}

function decodePayload(token: string): SteamSession | null {
  try {
    const seg = token.split('.')[0];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    const p = JSON.parse(json) as SteamSession;
    return p?.steamId && typeof p.exp === 'number' ? p : null;
  } catch {
    return null;
  }
}

/** Capture a token arriving in the URL fragment after a Steam login redirect. */
export function captureTokenFromHash(): { error?: string } {
  if (typeof window === 'undefined') return {};
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return {};
  const params = new URLSearchParams(hash);
  const err = params.get('auth_error');
  const token = params.get('token');
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
  }
  if (token || err) {
    // Strip the fragment so the token doesn't linger in the address bar / history.
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return err ? { error: err } : {};
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY);
}

/** The current session, or null if absent/expired. Clears expired tokens. */
export function getSession(): SteamSession | null {
  const token = getToken();
  if (!token) return null;
  const s = decodePayload(token);
  if (!s || Date.now() > s.exp) {
    logout();
    return null;
  }
  return s;
}

/** Authorization header to merge into fetch() calls (empty if signed out). */
export function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Send the user to Steam, returning them to this exact editor page afterward. */
export function login(analyticsBase: string): void {
  const next = window.location.origin + window.location.pathname;
  window.location.href = `${analyticsBase}/api/auth/steam/login?next=${encodeURIComponent(next)}`;
}

export function logout(): void {
  if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_KEY);
}
