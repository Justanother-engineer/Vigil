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
  const serializablePatterns = await fetchPatternsFromSource(PATTERNS_URL);
  if (serializablePatterns) {
    try {
      await chrome.storage.local.set({
        [PATTERNS_STORAGE_KEY]: serializablePatterns,
        [LAST_UPDATED_STORAGE_KEY]: Date.now()
      });
      console.log('[Vigil] Remote patterns stored.');
    } catch (error) {
      console.error('[Vigil] Failed to store remote patterns:', error);
    }
  }
  return serializablePatterns;
}

async function getEffectivePatterns() {
  let serializablePatterns = (await chrome.storage.local.get([PATTERNS_STORAGE_KEY]))[PATTERNS_STORAGE_KEY];

  if (!(Array.isArray(serializablePatterns) && serializablePatterns.every(p => p && typeof p.source === 'string'))) {
    serializablePatterns = null;
  }

  if (!serializablePatterns) {
    serializablePatterns = await fetchAndStoreRemotePatterns();
  }

  if (!serializablePatterns) {
    console.warn("[Vigil] Using local fallback patterns.");
    serializablePatterns = await fetchPatternsFromSource(LOCAL_PATTERNS_PATH, true);
  }

  return serializablePatterns ? serializablePatterns.map(p => new RegExp(p.source, p.flags || '')) : [];
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
          const textToValidate = request.text;
          const currentPatterns = await getEffectivePatterns();
          let { scannedEntries = 0, maliciousFound = 0 } = await chrome.storage.local.get(['scannedEntries', 'maliciousFound']);
          scannedEntries++;
          const isMalicious = currentPatterns.some(pattern => pattern.test(textToValidate));

          const updatesToStore = { scannedEntries };
          if (isMalicious) {
            maliciousFound++;
            updatesToStore.maliciousFound = maliciousFound;
            chrome.tabs.sendMessage(sender.tab.id, { type: "showSecurityAlertUI", text: textToValidate })
              .catch(err => console.warn("[Vigil] Could not send UI alert to tab:", err.message));
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
