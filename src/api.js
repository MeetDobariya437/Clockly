import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { CONFIG } from './config.js';
import { getLocation } from './location.js';

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

// In-memory mock attendance state for mock mode testing
const mockState = {
  token: 'mock-auth-token-12345',
  checkedIn: false,
  checkInTime: null,
};

/**
 * Accessor for token saved securely in OS Keychain (with dev-server fallback)
 */
export async function getSavedToken() {
  if (!isTauri) {
    return sessionStorage.getItem('clocky_browser_token');
  }
  try {
    return await invoke('keychain_get_token');
  } catch (err) {
    console.error('Failed to read token from keychain:', err);
    return null;
  }
}

export async function saveToken(token) {
  if (!isTauri) {
    sessionStorage.setItem('clocky_browser_token', token);
    return;
  }
  try {
    await invoke('keychain_save_token', { token });
  } catch (err) {
    console.error('Failed to save token to keychain:', err);
    throw new Error('Could not securely store credentials in keychain.');
  }
}

export async function deleteToken() {
  if (!isTauri) {
    sessionStorage.removeItem('clocky_browser_token');
    return;
  }
  try {
    await invoke('keychain_delete_token');
  } catch (err) {
    console.error('Failed to remove token from keychain:', err);
  }
}

function getDotPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, part) => (acc != null ? acc[part] : undefined), obj);
}

function validateBaseUrl(url) {
  if (!url) throw new Error('BASE_URL is not configured.');
  const lower = url.toLowerCase();
  const isHttps = lower.startsWith('https://');
  const isLocalhost = lower.startsWith('http://localhost') || lower.startsWith('http://127.0.0.1');
  if (!isHttps && !isLocalhost) {
    throw new Error('Security policy violation: BASE_URL must use HTTPS (except for local development).');
  }
}

async function sendRequest(method, path, body = null, token = null) {
  validateBaseUrl(CONFIG.BASE_URL);

  const url = `${CONFIG.BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (token) {
    Object.assign(headers, CONFIG.AUTH_HEADER(token));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const options = {
      method: method.toUpperCase(),
      headers,
      signal: controller.signal,
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
      options.body = JSON.stringify(body);
    }

    const fetchImpl = isTauri ? tauriFetch : window.fetch.bind(window);
    const response = await fetchImpl(url, options);

    if (response.status === 401) {
      await deleteToken();
      const unauthorizedErr = new Error('Session expired or unauthorized. Please log in again.');
      unauthorizedErr.status = 401;
      throw unauthorizedErr;
    }

    let json = null;
    const text = await response.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      const serverMsg = json?.message || json?.error || `Server responded with error (${response.status})`;
      const err = new Error(serverMsg);
      err.status = response.status;
      err.data = json;
      throw err;
    }

    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please check your network and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function apiLogin(username, password) {
  if (CONFIG.MOCK) {
    await new Promise((r) => setTimeout(r, 600));
    if (!username || !password) {
      throw new Error('Please enter both username and password.');
    }
    if (username.toLowerCase() === 'fail') {
      throw new Error('Invalid username or password.');
    }
    const token = mockState.token;
    await saveToken(token);
    return token;
  }

  const endpoint = CONFIG.ENDPOINTS.LOGIN;
  const body = CONFIG.LOGIN_BODY(username, password);
  const data = await sendRequest(endpoint.method, endpoint.path, body);

  const token = getDotPath(data, CONFIG.TOKEN_PATH);
  if (!token) {
    throw new Error(`Token not found at path '${CONFIG.TOKEN_PATH}' in server response.`);
  }

  await saveToken(token);
  return token;
}

export async function apiGetStatus(token) {
  if (CONFIG.MOCK) {
    await new Promise((r) => setTimeout(r, 300));
    return {
      checkedIn: mockState.checkedIn,
      checkInTime: mockState.checkInTime,
    };
  }

  const endpoint = CONFIG.ENDPOINTS.STATUS;
  const statusBody = CONFIG.STATUS_BODY
    ? CONFIG.STATUS_BODY()
    : (endpoint.method === 'POST' ? { month: new Date().toISOString().slice(0, 7) } : null);
  const data = await sendRequest(endpoint.method, endpoint.path, statusBody, token);
  return CONFIG.PARSE_STATUS(data);
}

export async function apiCheckIn(token) {
  const loc = await getLocation();

  if (CONFIG.MOCK) {
    await new Promise((r) => setTimeout(r, 700));
    mockState.checkedIn = true;
    mockState.checkInTime = new Date().toISOString();
    return {
      checkedIn: true,
      checkInTime: mockState.checkInTime,
    };
  }

  if (CONFIG.LOCATION_MODE === 'separate' && CONFIG.ENDPOINTS.LOCATION?.enabled) {
    const locEndpoint = CONFIG.ENDPOINTS.LOCATION;
    await sendRequest(locEndpoint.method, locEndpoint.path, CONFIG.LOCATION_BODY(loc), token);
  }

  let body = {};
  if (CONFIG.LOCATION_MODE === 'inline') {
    body = { ...CONFIG.LOCATION_BODY(loc) };
  }

  const endpoint = CONFIG.ENDPOINTS.CHECK_IN;
  await sendRequest(endpoint.method, endpoint.path, body, token);
  return await apiGetStatus(token);
}

export async function apiCheckOut(token) {
  const loc = await getLocation();

  if (CONFIG.MOCK) {
    await new Promise((r) => setTimeout(r, 700));
    mockState.checkedIn = false;
    mockState.checkInTime = null;
    return {
      checkedIn: false,
      checkInTime: null,
    };
  }

  if (CONFIG.LOCATION_MODE === 'separate' && CONFIG.ENDPOINTS.LOCATION?.enabled) {
    const locEndpoint = CONFIG.ENDPOINTS.LOCATION;
    await sendRequest(locEndpoint.method, locEndpoint.path, CONFIG.LOCATION_BODY(loc), token);
  }

  let body = {};
  if (CONFIG.LOCATION_MODE === 'inline') {
    body = { ...CONFIG.LOCATION_BODY(loc) };
  }

  const endpoint = CONFIG.ENDPOINTS.CHECK_OUT;
  await sendRequest(endpoint.method, endpoint.path, body, token);
  return await apiGetStatus(token);
}
