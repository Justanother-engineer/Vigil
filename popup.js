document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  const safeListView = document.getElementById('safeListView');

  const openSettingsButton = document.getElementById('openSettingsButton');
  const closeSettingsButton = document.getElementById('closeSettingsButton');

  const enableExtensionToggle = document.getElementById('enableExtensionToggle');
  const enableExtensionToggleSettings = document.getElementById('enableExtensionToggleSettings');
  const enableClipboardMonToggle = document.getElementById('enableClipboardMonToggle');

  const scanProgressBarFill = document.getElementById('scanProgressBarFill');
  const scanStatsText = document.getElementById('scanStatsText');

  const viewSafeListButton = document.getElementById('viewSafeListButton');
  const closeSafeListViewButton = document.getElementById('closeSafeListViewButton');
  const safeListElement = document.getElementById('safeListElement');
  const noSafeListEntriesText = document.getElementById('noSafeListEntries');

  const VIGIL_SAFE_LIST_KEY = 'vigilSafeList';

  // --- View Management ---
  function showView(viewToShow) {
    [mainView, settingsView, safeListView].forEach(view => {
      if (view) view.style.display = 'none';
    });
    if (viewToShow) viewToShow.style.display = 'block';
  }

  // --- Data Loading and Display ---
  async function loadInitialData() {
    try {
      const data = await chrome.storage.local.get([
        'extensionEnabled',
        'clipboardMonitoringEnabled',
        'scannedEntries',
        'maliciousFound'
      ]);

      const extEnabled = data.extensionEnabled ?? true;
      const clipMonEnabled = data.clipboardMonitoringEnabled ?? true;

      if (enableExtensionToggle) enableExtensionToggle.checked = extEnabled;
      if (enableExtensionToggleSettings) enableExtensionToggleSettings.checked = extEnabled;
      if (enableClipboardMonToggle) enableClipboardMonToggle.checked = clipMonEnabled;

      updateStatsDisplay(data.scannedEntries ?? 0, data.maliciousFound ?? 0);

    } catch (error) {
      console.error("Error loading initial data for popup:", error);
    }
  }

  function updateStatsDisplay(scanned, malicious) {
    const totalScanned = scanned || 0;
    const totalMalicious = malicious || 0;
    const percentage = totalScanned > 0 ? ((totalMalicious / totalScanned) * 100).toFixed(1) : 0;

    if (scanStatsText) scanStatsText.textContent = `Malicious: ${totalMalicious} / Total: ${totalScanned} (${percentage}%)`;
    if (scanProgressBarFill) {
        scanProgressBarFill.style.width = `${percentage}%`;
    }
  }

  // --- Event Listeners Setup ---
  function setupToggleListeners() {
    if (enableExtensionToggle) {
      enableExtensionToggle.addEventListener('change', async (event) => {
        await chrome.storage.local.set({ extensionEnabled: event.target.checked });
        // UI sync handled by chrome.storage.onChanged
      });
    }

    if (enableExtensionToggleSettings) {
      enableExtensionToggleSettings.addEventListener('change', async (event) => {
        await chrome.storage.local.set({ extensionEnabled: event.target.checked });
        // UI sync handled by chrome.storage.onChanged
      });
    }

    if (enableClipboardMonToggle) {
      enableClipboardMonToggle.addEventListener('change', async (event) => {
        await chrome.storage.local.set({ clipboardMonitoringEnabled: event.target.checked });
      });
    }
  }

  if (openSettingsButton) openSettingsButton.addEventListener('click', () => showView(settingsView));
  if (closeSettingsButton) closeSettingsButton.addEventListener('click', () => showView(mainView));

  if (viewSafeListButton) {
    viewSafeListButton.addEventListener('click', () => {
      showView(safeListView);
      loadAndDisplaySafeListEntries();
    });
  }
  if (closeSafeListViewButton) closeSafeListViewButton.addEventListener('click', () => showView(settingsView));

  // --- Safe List Management ---
  async function loadAndDisplaySafeListEntries() {
    if (!safeListElement || !noSafeListEntriesText) {
        console.error("Safe list UI elements not found for display.");
        return;
    }
    try {
      const safeList = await chrome.runtime.sendMessage({ type: 'getSafeList' });
      safeListElement.innerHTML = ''; // Clear previous entries

      if (safeList && safeList.length > 0) {
        noSafeListEntriesText.style.display = 'none';
        safeList.forEach(text => {
          const listItem = document.createElement('li');
          listItem.classList.add('safe-list-item');

          const textSpan = document.createElement('span');
          textSpan.classList.add('safe-list-item-text');
          textSpan.textContent = text.length > 50 ? text.substring(0, 47) + '...' : text;
          textSpan.title = text; // Full text on hover

          const deleteButton = document.createElement('button');
          deleteButton.innerHTML = '&#10005;'; // Cross mark
          deleteButton.classList.add('safe-list-item-delete');
          deleteButton.title = "Remove from Safe List";
          deleteButton.addEventListener('click', async () => {
            try {
              await chrome.runtime.sendMessage({ type: 'deleteFromSafeList', text: text });
              loadAndDisplaySafeListEntries(); // Refresh list
            } catch (e) {
              console.error("Error deleting safe list entry:", e);
            }
          });

          listItem.appendChild(textSpan);
          listItem.appendChild(deleteButton);
          safeListElement.appendChild(listItem);
        });
      } else {
        noSafeListEntriesText.style.display = 'block';
      }
    } catch (error) {
      console.error("Error loading safe list entries:", error);
      safeListElement.innerHTML = '<li class="safe-list-item-error">Error loading entries.</li>';
      noSafeListEntriesText.style.display = 'none';
    }
  }

  // --- Storage Change Listener ---
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      // Update stats if relevant data changed
      if (changes.scannedEntries || changes.maliciousFound) {
        chrome.storage.local.get(['scannedEntries', 'maliciousFound']).then(data => {
          updateStatsDisplay(data.scannedEntries, data.maliciousFound);
        });
      }
      // Sync extension enable toggles
      if (changes.extensionEnabled) {
        const newValue = changes.extensionEnabled.newValue;
        if (enableExtensionToggle) enableExtensionToggle.checked = newValue;
        if (enableExtensionToggleSettings) enableExtensionToggleSettings.checked = newValue;
      }
      // Sync clipboard monitoring toggle
      if (changes.clipboardMonitoringEnabled && enableClipboardMonToggle) {
        enableClipboardMonToggle.checked = changes.clipboardMonitoringEnabled.newValue;
      }
      // Refresh safe list if it changed and is currently visible
      if (changes[VIGIL_SAFE_LIST_KEY] && safeListView && safeListView.style.display === 'block') {
        loadAndDisplaySafeListEntries();
      }
    }
  });

  // --- Initialization ---
  loadInitialData();
  setupToggleListeners();
  showView(mainView); // Show main view by default
});
