// Google Drive appData sync for Apex (Solara pattern; separate filename).

import { toPlainState, fromPlainState } from './store.js';

const TOKEN_KEY = 'apex-google-token';
const DRIVE_FILE = 'apex-trade-lab-v1.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTO_SYNC_MS = 3 * 60 * 1000;

export { DRIVE_FILE, DRIVE_SCOPE };

// How much "real" content a snapshot has — used to block empty overwrite.
export function syncContentWeight(state) {
  if (!state || typeof state !== 'object') return 0;
  const trades = Array.isArray(state.closedTrades) ? state.closedTrades.length : 0;
  const fills = Array.isArray(state.account?.fills) ? state.account.fills.length : 0;
  const board = Array.isArray(state.leaderboard) ? state.leaderboard.length : 0;
  const samples = Array.isArray(state.equitySamples) ? state.equitySamples.length : 0;
  const pos = state.account?.positions
    ? Object.keys(state.account.positions).length
    : 0;
  const lp = Number(state.ladder?.lp) || 0;
  return trades * 10 + fills + board * 3 + Math.min(samples, 50) + pos * 5 + (lp > 0 ? 5 : 0);
}

export function mergeDriveState(local, remote) {
  const localTs = Number(local.syncUpdatedAt) || 0;
  const remoteTs = Number(remote.syncUpdatedAt) || 0;
  const localW = syncContentWeight(local);
  const remoteW = syncContentWeight(remote);
  // Prefer heavier content when one side is empty (never let empty clobber cloud).
  let newer;
  let older;
  if (localW === 0 && remoteW > 0) {
    newer = remote;
    older = local;
  } else if (remoteW === 0 && localW > 0) {
    newer = local;
    older = remote;
  } else {
    newer = localTs >= remoteTs ? local : remote;
    older = newer === local ? remote : local;
  }

  const byId = new Map();
  for (const t of [...(older.closedTrades || []), ...(newer.closedTrades || [])]) {
    if (t && t.id) byId.set(t.id, t);
  }
  const closedTrades = [...byId.values()].sort(
    (a, b) => (a.closedAt || 0) - (b.closedAt || 0),
  );

  const boardMap = new Map();
  for (const row of [...(older.leaderboard || []), ...(newer.leaderboard || [])]) {
    if (!row) continue;
    const key = row.id || `${row.ts || 0}-${row.score || 0}`;
    const prev = boardMap.get(key);
    if (!prev || (row.ts || 0) >= (prev.ts || 0)) boardMap.set(key, row);
  }

  const settings = {
    ...(older.settings || {}),
    ...(newer.settings || {}),
    googleClientId: local.settings?.googleClientId || remote.settings?.googleClientId || '',
    googleConnected: !!local.settings?.googleConnected,
    autoSync: local.settings?.autoSync !== false,
  };

  return {
    ...newer,
    closedTrades,
    leaderboard: [...boardMap.values()]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 50),
    settings,
    syncUpdatedAt: Math.max(localTs, remoteTs, Date.now()),
  };
}

function getStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o.accessToken || !o.expiresAt) return null;
    if (Date.now() > o.expiresAt - 60_000) return null;
    return o.accessToken;
  } catch {
    return null;
  }
}

function storeToken(accessToken, expiresIn) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken,
    expiresAt: Date.now() + (expiresIn || 3600) * 1000,
  }));
}

function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function driveFindFile(token) {
  const q = `name='${DRIVE_FILE}' and 'appDataFolder' in parents and trashed=false`;
  return fetch(
    'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q='
      + encodeURIComponent(q) + '&fields=files(id,modifiedTime)',
    { headers: { Authorization: 'Bearer ' + token } },
  ).then((r) => r.json()).then((data) => (data.files && data.files[0]) || null);
}

function driveCreateFile(token, payload) {
  const boundary = 'apex_boundary';
  const meta = JSON.stringify({ name: DRIVE_FILE, parents: ['appDataFolder'] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + meta + `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`
    + JSON.stringify(payload) + `\r\n--${boundary}--`;
  return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  }).then((r) => r.json());
}

function driveUpdateFile(token, fileId, payload) {
  return fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
}

// Factory: bind get/set state + local save + UI hooks.
export function createDriveClient(hooks) {
  const {
    getState, setState, saveLocal, onStatus, toast,
  } = hooks;

  let googleTokenClient = null;
  let tokenPromiseResolve = null;
  let authPromptSkipped = false;
  let syncInFlight = null;
  let syncQueued = false;
  let uploadDebounce = null;
  let autoSyncTimer = null;

  function setSyncStatus(s) {
    if (onStatus) onStatus(s);
  }

  function initGoogleAuth() {
    const clientId = getState().settings?.googleClientId;
    if (!window.google?.accounts?.oauth2 || !clientId) return;
    googleTokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) {
          setSyncStatus('failed');
          if (tokenPromiseResolve) {
            tokenPromiseResolve(null);
            tokenPromiseResolve = null;
          }
          return;
        }
        storeToken(resp.access_token, resp.expires_in);
        const st = getState();
        st.settings.googleConnected = true;
        if (st.settings.autoSync === undefined) st.settings.autoSync = true;
        saveLocal();
        if (tokenPromiseResolve) {
          tokenPromiseResolve(resp.access_token);
          tokenPromiseResolve = null;
        }
      },
    });
  }

  function getAccessToken(prompt, opts = {}) {
    const interactive = opts.interactive !== false;
    const existing = getStoredToken();
    if (existing) return Promise.resolve(existing);
    if (!interactive) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (!googleTokenClient) initGoogleAuth();
      if (!googleTokenClient) {
        resolve(null);
        return;
      }
      tokenPromiseResolve = resolve;
      googleTokenClient.requestAccessToken({ prompt: prompt || '' });
    });
  }

  function keepDriveSession(prev, next) {
    if (prev.settings?.googleClientId) {
      next.settings.googleClientId = prev.settings.googleClientId;
    }
    next.settings.googleConnected = !!prev.settings?.googleConnected;
    next.settings.autoSync = prev.settings?.autoSync !== false;
    return next;
  }

  function shouldPushAfterMerge(result, hasFile) {
    if (result.action === 'noop') return false;
    if (!hasFile) return syncContentWeight(result.state) > 0;
    return true;
  }

  function driveSync(opts = {}) {
    const wantPush = opts.push !== false;
    const st0 = getState();
    if (!st0.settings?.googleConnected) return Promise.resolve();
    if (!opts.force && st0.settings.autoSync === false) return Promise.resolve();
    if (syncInFlight) {
      syncQueued = true;
      return syncInFlight;
    }
    setSyncStatus('syncing');

    const runQueued = (value) => {
      syncInFlight = null;
      if (syncQueued) {
        syncQueued = false;
        return driveSync({ push: true, force: !!opts.force }).then(() => value);
      }
      return value;
    };

    const wantInteractive = !!(opts.force || (opts.allowPrompt && !authPromptSkipped));
    const p = getAccessToken(opts.force ? '' : '', { interactive: wantInteractive })
      .then((token) => {
        if (!token) {
          if (wantInteractive && !opts.force) authPromptSkipped = true;
          setSyncStatus(opts.force ? 'failed' : 'needsAuth');
          return runQueued();
        }
        authPromptSkipped = false;
        return driveFindFile(token).then((file) => {
          const loadRemote = !file
            ? Promise.resolve({ file: null, remote: null, remoteTs: 0 })
            : fetch(
              `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
              { headers: { Authorization: 'Bearer ' + token } },
            ).then((r) => r.json()).then((remote) => ({
              file,
              remote,
              remoteTs: new Date(file.modifiedTime).getTime(),
            }));

          return loadRemote.then((pack) => {
            const prev = getState();
            const fromEmpty = syncContentWeight(prev) === 0;
            let result;
            if (pack.remote) {
              const remoteLive = fromPlainState(pack.remote);
              const merged = mergeDriveState(prev, remoteLive);
              result = {
                state: merged,
                winner: (Number(prev.syncUpdatedAt) || 0)
                  >= (Number(remoteLive.syncUpdatedAt) || pack.remoteTs)
                  ? 'local'
                  : 'remote',
                action: 'push',
              };
            } else {
              result = {
                state: prev,
                winner: 'local',
                action: syncContentWeight(prev) > 0 ? 'push' : 'noop',
              };
            }
            const next = keepDriveSession(prev, result.state);
            setState(next);
            saveLocal();
            if (fromEmpty && (result.winner === 'remote' || pack.remote)) {
              if (toast) toast('已從雲端還原資料');
            }
            let doPush = wantPush && shouldPushAfterMerge(result, !!pack.file);
            if (
              doPush
              && syncContentWeight(getState()) === 0
              && pack.remote
              && syncContentWeight(pack.remote) > 0
            ) {
              doPush = false;
            }
            if (!doPush) {
              setSyncStatus('synced');
              return runQueued(result);
            }
            const stPush = getState();
            stPush.syncUpdatedAt = Date.now();
            const payload = toPlainState(stPush);
            const write = pack.file
              ? driveUpdateFile(token, pack.file.id, payload)
              : driveCreateFile(token, payload);
            return write.then(() => {
              saveLocal();
              setSyncStatus('synced');
              return runQueued(result);
            });
          });
        });
      });

    syncInFlight = p;
    p.catch(() => {
      if (syncInFlight === p) syncInFlight = null;
      setSyncStatus('failed');
      if (syncQueued) {
        syncQueued = false;
        driveSync({ push: true, force: !!opts.force });
      }
    });
    return p;
  }

  function scheduleUpload() {
    const st = getState();
    if (!st.settings?.googleConnected || st.settings.autoSync === false) return;
    clearTimeout(uploadDebounce);
    uploadDebounce = setTimeout(() => {
      driveSync({ push: true });
    }, 1500);
  }

  function startAutoSyncLoop() {
    clearInterval(autoSyncTimer);
    const st = getState();
    if (!st.settings?.googleConnected || st.settings.autoSync === false) return;
    autoSyncTimer = setInterval(() => {
      if (document.visibilityState === 'visible') driveSync({ push: true });
    }, AUTO_SYNC_MS);
  }

  function connect(clientId) {
    const st = getState();
    st.settings.googleClientId = (clientId || '').trim();
    if (!st.settings.googleClientId) {
      if (toast) toast('請輸入 OAuth Client ID');
      return Promise.resolve(false);
    }
    saveLocal();
    initGoogleAuth();
    if (!googleTokenClient) {
      if (toast) toast('Google 登入載入中，請稍後再試');
      return Promise.resolve(false);
    }
    setSyncStatus('syncing');
    authPromptSkipped = false;
    return getAccessToken('consent', { interactive: true }).then((token) => {
      if (!token) {
        setSyncStatus('failed');
        if (toast) toast('連接失敗');
        return false;
      }
      const s = getState();
      s.settings.googleConnected = true;
      s.settings.autoSync = true;
      saveLocal();
      return driveSync({ push: true, force: true }).then(() => {
        startAutoSyncLoop();
        if (toast) toast('已連接 Google Drive');
        return true;
      });
    });
  }

  function disconnect() {
    const st = getState();
    st.settings.googleConnected = false;
    clearStoredToken();
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
    saveLocal();
    setSyncStatus('disconnected');
    if (toast) toast('已斷開 Google Drive');
  }

  function boot() {
    initGoogleAuth();
    const st = getState();
    if (st.settings?.googleConnected) {
      driveSync({ push: true, allowPrompt: true }).then(() => startAutoSyncLoop());
    } else {
      setSyncStatus('disconnected');
    }
  }

  return {
    boot,
    connect,
    disconnect,
    sync: driveSync,
    scheduleUpload,
    startAutoSyncLoop,
    initGoogleAuth,
    statusLabel(status) {
      if (status === 'synced') return '已同步';
      if (status === 'syncing') return '同步中…';
      if (status === 'needsAuth') return '需要重新登入';
      if (status === 'failed') return '同步失敗';
      if (getState().settings?.googleConnected) return '已連接';
      return '未連接';
    },
  };
}
