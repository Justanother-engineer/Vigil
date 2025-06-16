// Global state variables
let lastClipboardText = ''; // Stores the most recently processed clipboard text.
let lastAlertedText = null; // Stores the text for which an alert was last shown, to prevent re-alerting.
const POLLING_INTERVAL = 500; // Interval in milliseconds for polling the clipboard.
let extensionIsEnabled = true; // Tracks if the overall extension functionality is enabled.
let clipboardMonitoringIsEnabled = true; // Tracks if clipboard monitoring specifically is enabled.
const VIGIL_SAFE_LIST_KEY = 'vigilSafeList'; // Key for storing the safe list in chrome.storage.local.
let validationInProgressForText = null; // Stores text currently being validated to prevent redundant parallel validations.

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
  // Avoid re-processing if this exact text is already undergoing validation.
  if (validationInProgressForText === textString) return;

  // Abort if extension context is invalid (e.g., background service worker terminated).
  if (!chrome.runtime || !chrome.runtime.id) {
    console.warn('[Vigil Clipboard] Extension context invalidated. Aborting clipboard processing for this event.');
    return;
  }

  let isInSafeList = false;
  try {
    isInSafeList = await chrome.runtime.sendMessage({ type: 'isTextInSafeList', text: textString });
    if (isInSafeList) {
      lastClipboardText = textString;
      lastAlertedText = null; // Clear last alerted text if current text is safelisted.
      return;
    }
  } catch (error) {
    if (isCommunicationError(error)) {
      console.warn('[Vigil Clipboard] Background service unavailable for Safe List check. Aborting current clipboard processing.');
      return; // Exit to prevent further errors for this event.
    }
    console.error('[Vigil Clipboard] Error checking Safe List:', error.message, error.stack || '');
    // For other errors, isInSafeList remains false, and the function will proceed.
  }

  // Avoid re-alerting if text is polled, was the last alerted, and hasn't changed from last processed.
  if (source === "polled" && textString === lastAlertedText && textString === lastClipboardText) return;

  lastClipboardText = textString;

  if (textString.trim() !== '') {
    try {
      validationInProgressForText = textString;
      // Re-check runtime context before sending validation message.
      if (!chrome.runtime || !chrome.runtime.id) {
          console.warn('[Vigil Clipboard] Extension context invalidated before validation. Aborting this attempt.');
          // Throwing an error here ensures the 'finally' block runs to clear validationInProgressForText.
          throw new Error("Extension context invalidated prior to validation send.");
      }
      const response = await chrome.runtime.sendMessage({ type: 'validateCopiedText', text: textString });
      if (response?.isMalicious) {
        lastAlertedText = textString; // Mark text as alerted.
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
    await processAndRelayClipboardText(currentClipboardText, "polled");
  } catch (err) {
    // Silently ignore errors from readText (e.g., page not focused, permission denied by user).
    // These are common and usually not indicative of an extension problem.
  }
}

setInterval(checkClipboard, POLLING_INTERVAL); // Start clipboard polling.

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
  const alertId = 'custom-security-alert-extension-injected';
  const overlayId = 'custom-security-alert-overlay-extension-injected';

  // Remove any existing alert elements.
  document.getElementById(alertId)?.remove();
  document.getElementById(overlayId)?.remove();

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  if (!document.body) { // Ensure body is available before appending.
    console.warn('[Vigil Clipboard] document.body not available, cannot show alert overlay.');
    return;
  }
  document.body.appendChild(overlay);

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

  if (!document.body) { // Double-check body before appending alert container.
     console.warn('[Vigil Clipboard] document.body not available, cannot show alert container.');
     overlay.remove(); // Clean up overlay if alert cannot be shown.
     return;
  }
  document.body.appendChild(alertContainer);

  function removeDialog() {
    const alertElement = document.getElementById(alertId);
    const overlayElement = document.getElementById(overlayId);
    alertElement?.classList.remove('visible');
    overlayElement?.classList.remove('visible');

    if (lastAlertedText === copiedText) lastAlertedText = null;

    // Allow fade-out animation before removing from DOM.
    setTimeout(() => {
      alertElement?.remove();
      overlayElement?.remove();
    }, 400);
  }

  alertContainer.querySelector('.cancel-button').addEventListener('click', () => {
    navigator.clipboard.writeText(' ') // Attempt to clear clipboard content.
      .catch(err => console.error('[Vigil Clipboard] Failed to clear clipboard:', err.message));
    lastClipboardText = ' ';
    removeDialog();
  });

  alertContainer.querySelector('.ok-button').addEventListener('click', () => {
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn('[Vigil Clipboard] Extension context invalidated. Cannot add to Safe List.');
      removeDialog(); // Still remove dialog.
      return;
    }
    chrome.runtime.sendMessage({ type: 'addToSafeList', text: copiedText })
      .catch(err => {
        if (isCommunicationError(err)) {
          console.warn('[Vigil Clipboard] Background service unavailable for addToSafeList. Action aborted.');
        } else {
          console.error('[Vigil Clipboard] Error sending addToSafeList:', err.message, err.stack || '');
        }
      })
      .finally(() => {
        removeDialog(); // Ensure dialog is always removed.
      });
  });

  // Make alert visible and focus the cancel button after a brief delay for rendering.
  setTimeout(() => {
    document.getElementById(alertId)?.classList.add('visible');
    document.getElementById(overlayId)?.classList.add('visible');
    alertContainer.querySelector('.cancel-button')?.focus();
  }, 10);
}
