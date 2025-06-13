import { maliciousPatterns } from './patterns.js';

// Initialize counts in storage if they don't exist
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const result = await chrome.storage.local.get(['scannedEntries', 'maliciousFound']);
    if (result.scannedEntries === undefined) {
      await chrome.storage.local.set({ scannedEntries: 0 });
    }
    if (result.maliciousFound === undefined) {
      await chrome.storage.local.set({ maliciousFound: 0 });
    }
  } catch (error) {
    console.error("Error during onInstalled storage initialization:", error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Use an Immediately Invoked Function Expression (IIFE) to handle async operations
  (async () => {
    try {
      if (request.type === 'validateCopiedText') {
        const textToValidate = request.text;
        // console.log("[Validator] Received text:", JSON.stringify(textToValidate));

        let { scannedEntries = 0 } = await chrome.storage.local.get('scannedEntries');
        scannedEntries++;
        await chrome.storage.local.set({ scannedEntries });
        // console.log("Total scanned entries:", scannedEntries);

        const isMalicious = maliciousPatterns.some(pattern => pattern.test(textToValidate));

        if (isMalicious) {
          let { maliciousFound = 0 } = await chrome.storage.local.get('maliciousFound');
          maliciousFound++;
          await chrome.storage.local.set({ maliciousFound });
          // console.log("Malicious entry recorded, total:", maliciousFound);

          if (sender.tab && sender.tab.id) {
            try {
              // No need to await this if we're not waiting for a response from content script here
              chrome.tabs.sendMessage(sender.tab.id, {
                type: "showSecurityAlertUI",
                text: textToValidate
              });
            } catch (error) {
              console.warn("Could not send 'showSecurityAlertUI' message to content script:", error.message);
            }
          }
          sendResponse({ status: "processed_malicious_alerted", isMalicious: true });
        } else {
          sendResponse({ status: "processed_not_malicious", isMalicious: false });
        }
      } else if (request.type === 'userMarkedAsOk') {
        // console.log("Received 'userMarkedAsOk' for text:", request.text);
        let { maliciousFound = 0 } = await chrome.storage.local.get('maliciousFound');
        if (maliciousFound > 0) {
          maliciousFound--; // Decrement the count
        }
        await chrome.storage.local.set({ maliciousFound });
        // console.log("Malicious count decremented due to user 'Mark as OK', new total:", maliciousFound);
        sendResponse({ status: "maliciousCountDecremented" });
      }
    } catch (error) {
      console.error("Error in onMessage listener:", error);
      // Optionally send an error response if appropriate for the message type
      // sendResponse({ status: "error", message: error.message });
    }
  })();

  return true; // Crucial: Indicates that sendResponse will be called asynchronously.
});
