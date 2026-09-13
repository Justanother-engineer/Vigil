const PATTERNS_URL = 'https://raw.githubusercontent.com/Justanother-engineer/Vigil/refs/heads/main/pattern.json';
const LOCAL_PATTERNS_PATH = 'pattern.json';
const PATTERNS_STORAGE_KEY = 'vigilDynamicPatterns';
const LAST_UPDATED_STORAGE_KEY = 'vigilPatternsLastUpdated';
const PATTERNS_UPDATE_ALARM_NAME = 'updateVigilPatternsAlarm';
const UPDATE_INTERVAL_MINUTES = 24 * 60;
const VIGIL_SAFE_LIST_KEY = 'vigilSafeList';

async function fetchPatternsFromSource(sourcePath, isLocal = false) {
  const url = isLocal ? chrome.runtime.getURL(sourcePath) : sourcePath;
  try {
    const response = await fetch(url, { cache: isLocal ? 'default' : 'no-store' });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const fetchedPatterns = await response.json();
    if (Array.isArray(fetchedPatterns) && fetchedPatterns.every(p => p && typeof p.source === 'string')) {
      return fetchedPatterns;
    }
    console.error(`[Vigil] Invalid patterns from ${url}.`);
    return null;
  } catch (error) {
    console.error(`[Vigil] Failed to fetch/parse patterns from ${url}:`, error);
    return null;
  }
}

async function fetchAndStoreRemotePatterns() {
  // ponytail: query param defeats CDN edge caching so a fresh push applies on next reload.
  const serializablePatterns = await fetchPatternsFromSource(`${PATTERNS_URL}?t=${Date.now()}`);
  if (serializablePatterns && serializablePatterns.length > 0) {
    const updatedAt = Date.now();
    try {
      await chrome.storage.local.set({
        [PATTERNS_STORAGE_KEY]: serializablePatterns,
        [LAST_UPDATED_STORAGE_KEY]: updatedAt
      });
      console.log(`[Vigil] Remote patterns stored: ${serializablePatterns.length}, updated ${new Date(updatedAt).toISOString()}.`);
    } catch (error) {
      console.error('[Vigil] Failed to store remote patterns:', error);
    }
    return serializablePatterns;
  }
  console.warn('[Vigil] Empty remote patterns; keeping existing.');
  return null;
}

async function getEffectivePatterns() {
  const stored = await chrome.storage.local.get([PATTERNS_STORAGE_KEY, LAST_UPDATED_STORAGE_KEY]);
  let serializablePatterns = stored[PATTERNS_STORAGE_KEY];

  // Keep good stored entries even if some are malformed; miss only when none usable.
  serializablePatterns = Array.isArray(serializablePatterns)
    ? serializablePatterns.filter(p => p && typeof p.source === 'string')
    : [];
  if (serializablePatterns.length === 0) serializablePatterns = null;

  if (serializablePatterns) {
    const when = stored[LAST_UPDATED_STORAGE_KEY]
      ? new Date(stored[LAST_UPDATED_STORAGE_KEY]).toISOString()
      : 'unknown time';
    console.log(`[Vigil] Using stored patterns: ${serializablePatterns.length}, updated ${when}.`);
  }

  if (!serializablePatterns) {
    serializablePatterns = await fetchAndStoreRemotePatterns();
  }

  if (!serializablePatterns) {
    console.warn("[Vigil] Using local fallback patterns.");
    serializablePatterns = await fetchPatternsFromSource(LOCAL_PATTERNS_PATH, true);
  }

  return (serializablePatterns ?? []).flatMap(p => {
    try {
      // ponytail: skip one bad remote pattern instead of failing all detection.
      if (!p || typeof p.source !== 'string' || p.source.length > 1000) {
        console.warn('[Vigil] Skipping invalid pattern:', p && p.source);
        return [];
      }
      if (p.flags !== undefined && (typeof p.flags !== 'string' || !/^[gimsuy]*$/.test(p.flags))) {
        console.warn('[Vigil] Skipping pattern with invalid flags:', p.source, p.flags);
        return [];
      }
      return [new RegExp(p.source, p.flags || '')];
    } catch (error) {
      console.warn('[Vigil] Skipping invalid pattern:', p && p.source, error.message);
      return [];
    }
  });
}

async function initializeStorage() {
  try {
    const currentStorage = await chrome.storage.local.get(['scannedEntries', 'maliciousFound', VIGIL_SAFE_LIST_KEY]);
    const defaults = { scannedEntries: 0, maliciousFound: 0, [VIGIL_SAFE_LIST_KEY]: [] };
    const itemsToSet = Object.fromEntries(
      Object.entries(defaults).filter(([key, _]) => currentStorage[key] === undefined)
    );
    if (Object.keys(itemsToSet).length > 0) await chrome.storage.local.set(itemsToSet);
  } catch (error) {
    console.error("[Vigil] Error during storage initialization:", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeStorage();
  await fetchAndStoreRemotePatterns();
  chrome.alarms.create(PATTERNS_UPDATE_ALARM_NAME, { periodInMinutes: UPDATE_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === PATTERNS_UPDATE_ALARM_NAME) await fetchAndStoreRemotePatterns();
});

chrome.runtime.onStartup.addListener(async () => {
  await fetchAndStoreRemotePatterns();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.type) {
        case 'validateCopiedText': {
          const rawText = String(request.text ?? '');
          const textToValidate = rawText.slice(0, 16000); // ponytail: head-only; mirrors clipboard.js cap.
          const currentPatterns = await getEffectivePatterns();
          let { scannedEntries = 0, maliciousFound = 0 } = await chrome.storage.local.get(['scannedEntries', 'maliciousFound']);
          scannedEntries++;
          const isMalicious = currentPatterns.some(pattern => pattern.test(textToValidate));

          const updatesToStore = { scannedEntries };
          if (isMalicious) {
            maliciousFound++;
            updatesToStore.maliciousFound = maliciousFound;
            // UI/quarantine path carries full bytes; only the regex test used the head.
            const tabId = sender?.tab?.id;
            if (tabId != null) {
              chrome.tabs.sendMessage(tabId, { type: "showSecurityAlertUI", text: rawText })
                .catch(err => console.warn("[Vigil] Could not send UI alert to tab:", err.message));
            }
          }
          await chrome.storage.local.set(updatesToStore);
          sendResponse({ isMalicious });
          break;
        }
        case 'isTextInSafeList':
        case 'addToSafeList':
        case 'getSafeList':
        case 'deleteFromSafeList': {
          const { [VIGIL_SAFE_LIST_KEY]: list = [] } = await chrome.storage.local.get(VIGIL_SAFE_LIST_KEY);
          let newList = [...list];

          switch (request.type) {
            case 'isTextInSafeList':
              sendResponse(newList.includes(request.text));
              return;
            case 'addToSafeList':
              if (!newList.includes(request.text)) newList.push(request.text);
              break;
            case 'getSafeList':
              sendResponse(newList);
              return;
            case 'deleteFromSafeList':
              newList = newList.filter(item => item !== request.text);
              break;
          }

          await chrome.storage.local.set({ [VIGIL_SAFE_LIST_KEY]: newList });
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ error: "Unknown request type" });
      }
    } catch (error) {
      console.error("[Vigil] Error in onMessage:", request.type, error.message);
      const errorResponses = {
        isTextInSafeList: false,
        validateCopiedText: { isMalicious: false, error: error.message },
        getSafeList: [],
        default: { success: false, error: error.message }
      };
      sendResponse(errorResponses[request.type] || errorResponses.default);
    }
  })();
  return true;
});
