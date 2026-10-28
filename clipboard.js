// Global state variables
let lastClipboardText = ''; // Stores the most recently processed clipboard text.
let lastAlertedText = null; // Stores the text for which an alert was last shown, to prevent re-alerting.
const POLLING_INTERVAL = 500; // Interval in milliseconds for polling the clipboard.
let extensionIsEnabled = true; // Tracks if the overall extension functionality is enabled.
let clipboardMonitoringIsEnabled = true; // Tracks if clipboard monitoring specifically is enabled.
const VIGIL_SAFE_LIST_KEY = 'vigilSafeList'; // Key for storing the safe list in chrome.storage.local.
let validationInProgressForText = null; // Stores text currently being validated to prevent redundant parallel validations.
let quarantinedText = null; // ponytail: per-tab stash of cleared malware text; restore on safelist, drop on new copy/tab close.
let lastReadErrorMessage = null; // ponytail: warn once per distinct read failure; 500ms spam helps nobody.
const MAX_VALIDATE_LEN = 16000; // ponytail: head-only validation; tail evasion is the documented ceiling.

// Alert UI: same markup/CSS as before, now rendered inside a closed shadow root
// with a native Top Layer <dialog>. Styles are adopted rather than injected as a
// <style> node so page style-src CSP cannot block them.
const ALERT_STYLES = `
  :host { all: initial; }
  #custom-security-alert-extension-injected {
    position: fixed;
    top: 20px;
    right: -450px; /* Start off-screen */
    width: 400px;
    background-color: #ffffff;
    border: 1px solid #e0e0e0;
    border-left: 6px solid #d32f2f; /* Red accent for alert */
    box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
    padding: 25px;
    z-index: 2147483647;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    transition: right 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
    border-radius: 8px;
    color: #333;
    box-sizing: border-box;
  }

  #custom-security-alert-extension-injected.visible {
    right: 20px; /* Slide in */
  }

  #custom-security-alert-extension-injected h3 {
    margin-top: 0;
    margin-bottom: 15px;
    color: #d32f2f;
    font-size: 20px;
    font-weight: 600;
  }

  #custom-security-alert-extension-injected p {
    margin-bottom: 12px;
    font-size: 15px;
    line-height: 1.6;
  }

  #custom-security-alert-extension-injected .copied-text-preview {
    background-color: #f9f9f9;
    border: 1px solid #eeeeee;
    padding: 10px;
    border-radius: 4px;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 13px;
    max-height: 120px;
    overflow-y: auto;
    word-break: break-all;
    margin-bottom: 15px;
    color: #555;
  }

  #custom-security-alert-extension-injected .alert-buttons {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    margin-top: 20px;
  }

  #custom-security-alert-extension-injected .alert-buttons button {
    padding: 8px 12px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    transition: background-color 0.2s ease, box-shadow 0.2s ease;
    letter-spacing: 0.5px;
    white-space: nowrap;
    flex-shrink: 1;
  }

  #custom-security-alert-extension-injected .alert-buttons .cancel-button {
    background-color: #6c757d;
    color: white;
  }

  #custom-security-alert-extension-injected .alert-buttons .cancel-button:hover {
    background-color: #5a6268;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  #custom-security-alert-extension-injected .alert-buttons .ok-button {
    background-color: #4CAF50;
    color: white;
  }

  #custom-security-alert-extension-injected .alert-buttons .ok-button:hover {
    background-color: #45a049;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  #custom-security-alert-overlay-extension-injected {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5); /* Semi-transparent black */
    z-index: 2147483646;
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
    pointer-events: none;
  }

  #custom-security-alert-overlay-extension-injected.visible {
    opacity: 1;
    pointer-events: auto;
  }

  dialog {
    all: initial;
    position: fixed;
    inset: 0;
    margin: 0;
    width: 100vw;
    height: 100vh;
    max-width: none;
    max-height: none;
    padding: 0;
    border: 0;
    background: transparent;
    overflow: visible;
    display: block;
  }

  /* Transparent: the Vigil overlay div stays the visible dimmer. */
  dialog::backdrop { background: transparent; }
`;

let activeAlertHost = null;

// Helper function to identify common Chrome extension communication errors.
function isCommunicationError(error) {
  return error && error.message && (
    error.message.includes('Extension context invalidated') ||
    error.message.includes('Receiving end does not exist') ||
    error.message.includes('The message port closed before a response was received.')
  );
}

// Loads extension settings (enabled states) from storage.
async function loadSettings() {
  try {
    if (!chrome.storage || !chrome.storage.local) {
      console.log('[Vigil Clipboard] chrome.storage.local not available; using default settings.');
      return;
    }
    const result = await chrome.storage.local.get(['extensionEnabled', 'clipboardMonitoringEnabled']);
    extensionIsEnabled = result.extensionEnabled ?? true;
    clipboardMonitoringIsEnabled = result.clipboardMonitoringEnabled ?? true;
  } catch (error) {
    if (isCommunicationError(error)) {
        // Log as informational; default/previous settings will be used.
        console.log('[Vigil Clipboard] Background service unavailable during settings load. Using default/previous settings.');
    } else {
        console.error('[Vigil Clipboard] Error loading settings:', error.message, error.stack || '');
    }
  }
}

// Listen for changes in chrome.storage to update local settings variables.
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.extensionEnabled) {
      extensionIsEnabled = changes.extensionEnabled.newValue;
    }
    if (changes.clipboardMonitoringEnabled) {
      clipboardMonitoringIsEnabled = changes.clipboardMonitoringEnabled.newValue;
    }
    if (changes[VIGIL_SAFE_LIST_KEY]) {
      // If the safelist changes, re-check the current clipboard content if the extension context is valid.
      if (chrome.runtime && chrome.runtime.id) {
        checkClipboard();
      } else {
        console.warn('[Vigil Clipboard] Context invalidated, skipping safelist change re-evaluation.');
      }
    }
  }
});

loadSettings(); // Initialize settings on script load.

// Processes clipboard text: checks against safelist, then validates for malicious content.
async function processAndRelayClipboardText(newText, source) {
  if (!extensionIsEnabled || !clipboardMonitoringIsEnabled) return;

  const textString = String(newText); // Ensure text is a string.
  // Claim synchronously (before any await) so concurrent duplicates dedup.
  // Released on every exit: early returns below, the validation finally, and the backstop at function end.
  if (validationInProgressForText === textString) return;
  validationInProgressForText = textString;

  // Abort if extension context is invalid (e.g., background service worker terminated).
  if (!chrome.runtime || !chrome.runtime.id) {
    console.warn('[Vigil Clipboard] Extension context invalidated. Aborting clipboard processing for this event.');
    validationInProgressForText = null;
    return;
  }

  let isInSafeList = false;
  try {
    isInSafeList = await chrome.runtime.sendMessage({ type: 'isTextInSafeList', text: textString });
    if (isInSafeList) {
      lastClipboardText = textString;
      lastAlertedText = null; // Clear last alerted text if current text is safelisted.
      if (quarantinedText === textString) quarantinedText = null;
      validationInProgressForText = null;
      return;
    }
  } catch (error) {
    if (isCommunicationError(error)) {
      console.warn('[Vigil Clipboard] Background service unavailable for Safe List check. Aborting current clipboard processing.');
      validationInProgressForText = null;
      return; // Exit to prevent further errors for this event.
    }
    console.error('[Vigil Clipboard] Error checking Safe List:', error.message, error.stack || '');
    // For other errors, isInSafeList remains false, and the function will proceed.
  }

  // Avoid re-alerting if text is polled, was the last alerted, and hasn't changed from last processed.
  if (source === "polled" && textString === lastAlertedText && textString === lastClipboardText) {
    validationInProgressForText = null;
    return;
  }

  // New non-empty copy while a quarantine is pending wins; discard old stash (fail-closed: it stays cleared).
  if (quarantinedText !== null && textString.trim() !== '' && textString !== quarantinedText && textString !== lastAlertedText) {
    quarantinedText = null;
  }

  lastClipboardText = textString;

  if (textString.trim() !== '') {
    // Send only the head for validation; quarantine/restore/safelist keep full bytes.
    // In-flight flag already holds the full text (claimed above); do not overwrite with the head.
    const validationText = textString.slice(0, MAX_VALIDATE_LEN);
    try {
      // Re-check runtime context before sending validation message.
      if (!chrome.runtime || !chrome.runtime.id) {
          console.warn('[Vigil Clipboard] Extension context invalidated before validation. Aborting this attempt.');
          // Throwing an error here ensures the 'finally' block runs to clear validationInProgressForText.
          throw new Error("Extension context invalidated prior to validation send.");
      }
      const response = await chrome.runtime.sendMessage({ type: 'validateCopiedText', text: validationText });
      if (response?.isMalicious) {
        lastAlertedText = textString; // Mark text as alerted.
        // Quarantine: stash malware text and clear clipboard immediately so paste is safe pending user choice.
        quarantinedText = textString;
        try {
          await navigator.clipboard.writeText('');
          lastClipboardText = '';
        } catch (clearErr) {
          console.warn('[Vigil Clipboard] Failed to clear malicious clipboard text:', clearErr.message);
        }
      } else if (lastAlertedText === textString) {
        // If not malicious (or validation succeeded and it's not), clear alert status for this text.
        lastAlertedText = null;
      }
    } catch (error) {
      if (isCommunicationError(error)) {
        console.warn('[Vigil Clipboard] Background service unavailable for validation. Processing may be incomplete.');
      } else {
        console.error('[Vigil Clipboard] Error sending validation message:', error.message, error.stack || '');
      }
      // If any error occurs during validation (including communication errors),
      // and this text was the one last alerted for, clear lastAlertedText.
      // This prevents sticky alerts if validation fails temporarily.
      if (lastAlertedText === textString) {
        lastAlertedText = null;
      }
    } finally {
      validationInProgressForText = null; // Always clear validation-in-progress flag.
    }
  } else if (lastAlertedText === textString) {
    // If clipboard is now empty and it was the last alerted text, clear alert status.
    lastAlertedText = null;
  }
  // Backstop release for paths that never entered validation (e.g. empty text).
  if (validationInProgressForText === textString) validationInProgressForText = null;
}

// Periodically checks the clipboard content if the document has focus.
async function checkClipboard() {
  if (!extensionIsEnabled || !clipboardMonitoringIsEnabled || !document.hasFocus()) return;

  if (!chrome.runtime || !chrome.runtime.id) {
    // Log as info, as this is an expected state if background service is temporarily down.
    console.log('[Vigil Clipboard] Extension context invalidated. Skipping clipboard check.');
    return;
  }
  try {
    const currentClipboardText = await navigator.clipboard.readText();
    // Skip our own quarantine clear to avoid validate-write loops.
    if (currentClipboardText.trim() === '' && (quarantinedText !== null || lastClipboardText.trim() === '')) return;
    await processAndRelayClipboardText(currentClipboardText, "polled");
  } catch (err) {
    // Fail loud once per distinct error so dead polls are diagnosable; dedup avoids 500ms log spam.
    const readErrorMessage = (err && err.message) || String(err);
    if (readErrorMessage !== lastReadErrorMessage) {
      lastReadErrorMessage = readErrorMessage;
      console.warn('[Vigil Clipboard] Clipboard read failed (page unfocused or permission denied):', readErrorMessage);
    }
  }
}

setInterval(checkClipboard, POLLING_INTERVAL); // Start clipboard polling.
document.addEventListener('copy', () => checkClipboard()); // Immediate check on copy; poll remains the fallback.

// Handles messages from other parts of the extension (e.g., background script).
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!chrome.runtime || !chrome.runtime.id) {
    console.warn('[Vigil Clipboard] Context invalidated while receiving message:', request.type);
    return false; // Indicate response will not be sent as context is gone.
  }

  if (request.type === 'showSecurityAlertUI') {
    showAlertInPage(request.text);
    sendResponse({ status: "Alert UI initiated" });
    return true; // Indicates asynchronous response.
  }
  return false; // No handler for this message type, or synchronous response.
});

// Displays an in-page security alert UI.
function showAlertInPage(copiedText) {
  // Fail-closed: ensure malware is out of clipboard while alert is up.
  // Stash in per-tab temp variable; restore only on explicit safelist choice.
  if (quarantinedText === null) quarantinedText = copiedText;
  navigator.clipboard.writeText('').catch(() => {});
  lastClipboardText = '';
  const alertId = 'custom-security-alert-extension-injected';
  const overlayId = 'custom-security-alert-overlay-extension-injected';

  // Closed shadow internals are unreachable from the document, so a stored host
  // ref is the only way to retire the previous alert.
  if (activeAlertHost) {
    activeAlertHost.remove();
    activeAlertHost = null;
  }

  if (!document.documentElement) {
    console.warn('[Vigil Clipboard] documentElement not available, cannot show alert.');
    return;
  }

  // Host on documentElement, immune to page body swaps; inline styles keep page
  // CSS from moving or hiding it.
  const host = document.createElement('div');
  host.id = 'custom-security-alert-host-extension-injected';
  host.style.cssText = 'all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: auto !important;';

  const shadow = host.attachShadow({ mode: 'closed' });

  // Constructable stylesheets bypass page style-src CSP; fall back to a <style>
  // node when the browser lacks either constructable or adoptable sheets.
  try {
    if (!('adoptedStyleSheets' in shadow)) throw new Error('adoptedStyleSheets unsupported');
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(ALERT_STYLES);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = ALERT_STYLES;
    shadow.appendChild(style);
  }

  // Native Top Layer modal; Escape stays a no-op as before.
  const dialog = document.createElement('dialog');
  dialog.id = 'custom-security-alert-dialog-extension-injected';
  dialog.addEventListener('cancel', (e) => e.preventDefault());

  const overlay = document.createElement('div');
  overlay.id = overlayId;

  const alertContainer = document.createElement('div');
  alertContainer.id = alertId;
  // Alert UI structure.
  alertContainer.innerHTML = `
      <h3>⚠️ Security Alert</h3>
      <p>The text you copied appears to be a potentially malicious command or suspicious text:</p>
      <div class="copied-text-preview"></div>
      <p>Executing commands or following links associated with this text could harm your computer.</p>
      <p class="caution-note"><strong>Note:</strong> Please proceed only if you are aware of the workings of the script/command in question and understand the potential risks.</p>
      <div class="alert-buttons" style="display: flex; flex-direction: column; align-items: stretch; gap: 8px;">
          <button class="cancel-button">Cancel & Clear Clipboard</button>
          <button class="ok-button">Add to Safe List & Copy</button>
      </div>
  `;
  alertContainer.querySelector('.copied-text-preview').textContent = copiedText;

  dialog.appendChild(overlay);
  dialog.appendChild(alertContainer);
  shadow.appendChild(dialog);

  function removeDialog() {
    overlay.classList.remove('visible');
    alertContainer.classList.remove('visible');

    if (lastAlertedText === copiedText) lastAlertedText = null;

    // Allow fade-out animation before removing from DOM.
    setTimeout(() => {
      host.remove();
      if (activeAlertHost === host) activeAlertHost = null;
    }, 400);
  }

  alertContainer.querySelector('.cancel-button').addEventListener('click', () => {
    navigator.clipboard.writeText('') // Attempt to clear clipboard content.
      .catch(err => console.error('[Vigil Clipboard] Failed to clear clipboard:', err.message));
    lastClipboardText = '';
    quarantinedText = null;
    removeDialog();
  });

  alertContainer.querySelector('.ok-button').addEventListener('click', () => {
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn('[Vigil Clipboard] Extension context invalidated. Cannot add to Safe List.');
      removeDialog(); // Still remove dialog.
      return;
    }
    const textToRestore = quarantinedText ?? copiedText;
    // Safelist the exact bytes being restored so the restored text does not re-alert.
    chrome.runtime.sendMessage({ type: 'addToSafeList', text: textToRestore })
      .catch(err => {
        if (isCommunicationError(err)) {
          console.warn('[Vigil Clipboard] Background service unavailable for addToSafeList. Action aborted.');
        } else {
          console.error('[Vigil Clipboard] Error sending addToSafeList:', err.message, err.stack || '');
        }
      })
      .finally(async () => {
        try {
          await navigator.clipboard.writeText(textToRestore);
          lastClipboardText = textToRestore;
        } catch (err) {
          console.error('[Vigil Clipboard] Failed to restore clipboard:', err.message);
        }
        lastAlertedText = null;
        quarantinedText = null;
        removeDialog(); // Ensure dialog is always removed.
      });
  });

  // Host must be connected before showModal(); fall back to the open attribute
  // when the modal API is unavailable or the page's own modal conflicts.
  document.documentElement.appendChild(host);
  activeAlertHost = host;
  try {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  } catch {
    dialog.setAttribute('open', '');
  }

  // Make alert visible and focus the cancel button after a brief delay for rendering.
  setTimeout(() => {
    alertContainer.classList.add('visible');
    overlay.classList.add('visible');
    alertContainer.querySelector('.cancel-button')?.focus();
  }, 10);
}
