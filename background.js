import { maliciousPatterns } from './patterns.js';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'validateCopiedText') {
    const textToValidate = request.text;
    console.log("[Validator] Received text:", JSON.stringify(textToValidate)); // Log exact text

    const isMalicious = maliciousPatterns.some(pattern => pattern.test(request.text));

    if (isMalicious) {
      // If a malicious pattern is detected, send a message to the content script
      // in the tab where the copy event originated.
      if (sender.tab && sender.tab.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "showSecurityAlertUI", // New message type
          text: request.text
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("Could not send message to content script:", chrome.runtime.lastError.message);
            // Potentially handle cases where the content script isn't ready or available
          } else if (response && response.status) {
            console.log("Content script response:", response.status);
          }
        });
      }
    }
  }
});