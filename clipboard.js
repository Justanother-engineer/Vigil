let lastClipboardText = '';
let lastAlertedText = null;
const POLLING_INTERVAL = 1000;
let extensionIsEnabled = true;
let clipboardMonitoringIsEnabled = true;
const VIGIL_SAFE_LIST_KEY = 'vigilSafeList';
let validationInProgressForText = null;

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['extensionEnabled', 'clipboardMonitoringEnabled']);
    extensionIsEnabled = result.extensionEnabled ?? true;
    clipboardMonitoringIsEnabled = result.clipboardMonitoringEnabled ?? true;
  } catch (error) {
    console.error('[Vigil Clipboard] Error loading settings:', error);
  }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.extensionEnabled) {
      extensionIsEnabled = changes.extensionEnabled.newValue;
    }
    if (changes.clipboardMonitoringEnabled) {
      clipboardMonitoringIsEnabled = changes.clipboardMonitoringEnabled.newValue;
    }
    if (changes[VIGIL_SAFE_LIST_KEY]) {
      checkClipboard(); // Re-evaluate clipboard if safelist changes
    }
  }
});

loadSettings();

async function processAndRelayClipboardText(newText, source) {
  if (!extensionIsEnabled || !clipboardMonitoringIsEnabled) return;

  const textString = String(newText);
  if (validationInProgressForText === textString) return;

  let isInSafeList = false;
  try {
    isInSafeList = await chrome.runtime.sendMessage({ type: 'isTextInSafeList', text: textString });
    if (isInSafeList) {
      lastClipboardText = textString;
      lastAlertedText = null;
      return;
    }
  } catch (error) {
    console.error('[Vigil Clipboard] Error checking Safe List:', error.message);
  }

  if (source === "polled" && textString === lastAlertedText && textString === lastClipboardText) return;

  lastClipboardText = textString;

  if (textString.trim() !== '') {
    try {
      validationInProgressForText = textString;
      const response = await chrome.runtime.sendMessage({ type: 'validateCopiedText', text: textString });
      if (response?.isMalicious) {
        lastAlertedText = textString;
      } else if (lastAlertedText === textString) {
        lastAlertedText = null;
      }
    } catch (error) {
      console.error('[Vigil Clipboard] Error sending validation message:', error.message);
      if (lastAlertedText === textString) lastAlertedText = null;
    } finally {
      validationInProgressForText = null;
    }
  } else if (lastAlertedText === textString) {
    lastAlertedText = null;
  }
}

async function checkClipboard() {
  if (!extensionIsEnabled || !clipboardMonitoringIsEnabled || !document.hasFocus()) return;
  try {
    const currentClipboardText = await navigator.clipboard.readText();
    await processAndRelayClipboardText(currentClipboardText, "polled");
  } catch (err) {
    // Could not read clipboard (polling)
  }
}

setInterval(checkClipboard, POLLING_INTERVAL);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'showSecurityAlertUI') {
    showAlertInPage(request.text);
    sendResponse({ status: "Alert UI initiated" });
    return true;
  }
});

function showAlertInPage(copiedText) {
  const alertId = 'custom-security-alert-extension-injected';
  const overlayId = 'custom-security-alert-overlay-extension-injected';

  document.getElementById(alertId)?.remove();
  document.getElementById(overlayId)?.remove();

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  document.body.appendChild(overlay);

  const alertContainer = document.createElement('div');
  alertContainer.id = alertId;

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
  document.body.appendChild(alertContainer);

  function removeDialog() {
    const alertElement = document.getElementById(alertId);
    const overlayElement = document.getElementById(overlayId);
    alertElement?.classList.remove('visible');
    overlayElement?.classList.remove('visible');

    if (lastAlertedText === copiedText) lastAlertedText = null;
    validationInProgressForText = null; // Clear in all cases

    setTimeout(() => {
      alertElement?.remove();
      overlayElement?.remove();
    }, 400);
  }

  alertContainer.querySelector('.cancel-button').addEventListener('click', () => {
    navigator.clipboard.writeText(' ').catch(err => console.error('[Vigil Clipboard] Failed to clear clipboard:', err));
    lastClipboardText = ' ';
    removeDialog();
  });

  alertContainer.querySelector('.ok-button').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'addToSafeList', text: copiedText }).catch(err => console.error('[Vigil Clipboard] Error sending addToSafeList:', err.message));
    removeDialog();
  });

  setTimeout(() => {
    document.getElementById(alertId)?.classList.add('visible');
    document.getElementById(overlayId)?.classList.add('visible');
    alertContainer.querySelector('.cancel-button')?.focus();
  }, 10);
}
