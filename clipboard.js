// /home/jae/QWEN/clipboard.js

let lastClipboardText = ''; // Store the last known clipboard content

// --- Standard Copy Event Listener ---
document.addEventListener('copy', (event) => {
  const copiedText = window.getSelection().toString();
  if (copiedText) {
    console.log("User Copied (event):", copiedText);
    lastClipboardText = copiedText; // Update on user copy
    chrome.runtime.sendMessage({
      type: 'validateCopiedText',
      text: copiedText
    });
  }
});

// --- Intercept navigator.clipboard.writeText ---
if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
  const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);

  navigator.clipboard.writeText = function(text) {
    const textString = text.toString(); // Ensure it's a string
    console.log("Programmatic Copy (writeText intercepted):", textString);
    lastClipboardText = textString; // Update on programmatic write
    if (textString) {
      chrome.runtime.sendMessage({
        type: 'validateCopiedText',
        text: textString
      });
    }
    return originalWriteText(text);
  };
  console.log("navigator.clipboard.writeText has been patched by extension.");
} else {
  console.warn("navigator.clipboard.writeText is not available or not a function. Programmatic copies might not be intercepted.");
}

// --- Real-time Clipboard Monitoring (Basic) ---
async function checkClipboard() {
  try {
    if (document.hasFocus()) {
      const currentClipboardText = await navigator.clipboard.readText();
      if (currentClipboardText !== lastClipboardText) {
        console.log("Clipboard Changed (polled):", currentClipboardText);
        lastClipboardText = currentClipboardText;
        chrome.runtime.sendMessage({
          type: 'validateCopiedText',
          text: currentClipboardText
        });
      }
    }
  } catch (err) {
    // console.warn("Could not read clipboard (possibly due to tab not focused or permissions):", err.message);
  }
}

setInterval(checkClipboard, 500);

// --- UI Handling ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'showSecurityAlertUI') {
    showAlertInPage(request.text);
    sendResponse({ status: "Alert UI initiated by content script" });
    return true; // Keep channel open for async response if needed later
  }
});

function showAlertInPage(copiedText) {
  const alertId = 'custom-security-alert-extension-injected';
  const overlayId = 'custom-security-alert-overlay-extension-injected';

  // Remove any existing alert and overlay to prevent duplicates
  let existingAlert = document.getElementById(alertId);
  if (existingAlert) existingAlert.remove();
  let existingOverlay = document.getElementById(overlayId);
  if (existingOverlay) existingOverlay.remove();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  document.body.appendChild(overlay);

  // Create alert container
  const alertContainer = document.createElement('div');
  alertContainer.id = alertId;

  alertContainer.innerHTML = `
      <h3>⚠️ Security Alert</h3>
      <p>The text you copied appears to be a potentially malicious command or suspicious text:</p>
      <div class="copied-text-preview"></div>
      <p>Executing commands or following links associated with this text could harm your computer.</p>
      <div class="alert-buttons">
          <button class="cancel-button">Cancel & Clear Clipboard</button>
          <button class="ok-button">Mark as OK & Copy</button>
      </div>
  `;
  alertContainer.querySelector('.copied-text-preview').textContent = copiedText;
  document.body.appendChild(alertContainer);

  function removeDialog() {
    if (alertContainer) {
      alertContainer.classList.remove('visible');
    }
    if (overlay) {
      overlay.classList.remove('visible');
    }
    setTimeout(() => {
      const currentAlert = document.getElementById(alertId);
      if (currentAlert && currentAlert.parentElement) {
        currentAlert.remove();
      }
      const currentOverlay = document.getElementById(overlayId);
      if (currentOverlay && currentOverlay.parentElement) {
        currentOverlay.remove();
      }
    }, 300);
  }

  alertContainer.querySelector('.cancel-button').addEventListener('click', () => {
    navigator.clipboard.writeText(' ').then(() => {
      console.log('Clipboard cleared due to security alert cancellation.');
      lastClipboardText = ' ';
    }).catch(err => {
      console.error('Failed to clear clipboard:', err);
    });
    removeDialog();
  });

  alertContainer.querySelector('.ok-button').addEventListener('click', () => {
    // Inform background script that this was marked OK
    chrome.runtime.sendMessage({
      type: 'userMarkedAsOk',
      text: copiedText // Sending the text can be useful for more complex logic later
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("Error sending 'userMarkedAsOk' message:", chrome.runtime.lastError.message);
      } else if (response && response.status) {
        // console.log("Background response to 'userMarkedAsOk':", response.status);
      }
    });
    removeDialog();
  });

  setTimeout(() => {
      const currentAlert = document.getElementById(alertId);
      const currentOverlay = document.getElementById(overlayId);
      if (currentAlert) currentAlert.classList.add('visible');
      if (currentOverlay) currentOverlay.classList.add('visible');
  }, 10);
}
