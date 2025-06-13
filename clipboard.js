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
    // Validate the text being written programmatically
    if (textString) {
      chrome.runtime.sendMessage({
        type: 'validateCopiedText',
        text: textString
      });
    }
    // Call the original function to actually write to the clipboard
    return originalWriteText(text);
  };
  console.log("navigator.clipboard.writeText has been patched by extension.");
} else {
  console.warn("navigator.clipboard.writeText is not available or not a function. Programmatic copies might not be intercepted.");
}

// --- Real-time Clipboard Monitoring (Basic) ---
async function checkClipboard() {
  try {
    // Check if the document has focus to avoid errors when the tab is not active
    if (document.hasFocus()) {
      const currentClipboardText = await navigator.clipboard.readText();
      if (currentClipboardText !== lastClipboardText) {
        console.log("Clipboard Changed (polled):", currentClipboardText);
        lastClipboardText = currentClipboardText;
        // Optionally, you can also send this to background.js for validation
        // if you want to catch changes made by other means (e.g., other extensions, OS-level copy)
        chrome.runtime.sendMessage({
          type: 'validateCopiedText',
          text: currentClipboardText
        });
      }
    }
  } catch (err) {
    // Common errors: Document not focused, or clipboard permission denied by user for readText
    // console.warn("Could not read clipboard (possibly due to tab not focused or permissions):", err.message);
  }
}

// Poll the clipboard every 2 seconds (adjust as needed)
// Be mindful of performance implications with very frequent polling.
setInterval(checkClipboard, 500);

// --- UI Handling (remains the same) ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'showSecurityAlertUI') {
    showAlertInPage(request.text);
    sendResponse({ status: "Alert UI initiated by content script" });
    return true;
  }
});

function showAlertInPage(copiedText) {
  const alertId = 'custom-security-alert-extension-injected';
  let existingAlert = document.getElementById(alertId);
  if (existingAlert) {
    existingAlert.remove();
  }

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

  function removeAlertUI(element) {
    if (element) {
      element.classList.remove('visible');
      element.addEventListener('transitionend', () => {
        if (element.parentElement) {
          element.remove();
        }
      }, { once: true });
    }
  }

  alertContainer.querySelector('.cancel-button').addEventListener('click', () => {
    navigator.clipboard.writeText(' ').then(() => {
      console.log('Clipboard cleared due to security alert cancellation.');
      lastClipboardText = ' '; // Update our tracker
    }).catch(err => {
      console.error('Failed to clear clipboard:', err);
    });
    removeAlertUI(alertContainer);
  });

  alertContainer.querySelector('.ok-button').addEventListener('click', () => {
    removeAlertUI(alertContainer);
  });

  setTimeout(() => {
      alertContainer.classList.add('visible');
  }, 10);
}
