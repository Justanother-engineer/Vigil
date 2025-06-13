document.addEventListener('DOMContentLoaded', function () {
    const openSettingsButton = document.getElementById('openSettingsButton');
    const closeSettingsButton = document.getElementById('closeSettingsButton');
    const mainView = document.getElementById('mainView');
    const settingsView = document.getElementById('settingsView');

    // --- Stats Elements ---
    const maliciousProgressBarEl = document.getElementById('maliciousProgressBar');
    const maliciousPercentageTextEl = document.getElementById('maliciousPercentageText');

    // --- Main Toggles (Master Control) ---
    const enableExtensionToggle = document.getElementById('enableExtensionToggle'); // In mainView
    const enableExtensionToggleSettings = document.getElementById('enableExtensionToggleSettings'); // In settingsView

    // --- Sub-Settings Elements ---
    const enableClipboardMonToggle = document.getElementById('enableClipboardMonToggle');
    const enablePhishletMonToggle = document.getElementById('enablePhishletMonToggle');

    // --- View Toggling ---
    if (openSettingsButton && mainView && settingsView) {
        openSettingsButton.addEventListener('click', () => {
            mainView.style.display = 'none';
            settingsView.style.display = 'block';
        });
    }

    if (closeSettingsButton && mainView && settingsView) {
        closeSettingsButton.addEventListener('click', () => {
            settingsView.style.display = 'none';
            mainView.style.display = 'block';
        });
    }

    // --- Function to update stats display ---
    function updateStatsDisplay(scanned, malicious) {
        let percentage = 0;
        if (scanned > 0) {
            percentage = Math.min((malicious / scanned) * 100, 100);
        }
        if (maliciousProgressBarEl) maliciousProgressBarEl.style.width = `${percentage}%`;
        if (maliciousPercentageTextEl) maliciousPercentageTextEl.textContent = `${percentage.toFixed(1)}% Malicious`;
    }

    // --- Function to update sub-settings toggles based on main extension state ---
    function updateSubSettingsAvailability(isExtensionEnabled) {
        const subSettings = [
            { element: enableClipboardMonToggle, storageKey: 'clipboardMonitoringEnabled', defaultValue: true },
            { element: enablePhishletMonToggle, storageKey: 'phishletMonitoringEnabled', defaultValue: false }
        ];
        subSettings.forEach(setting => {
            if (setting.element) {
                setting.element.disabled = !isExtensionEnabled;
                if (!isExtensionEnabled) setting.element.checked = false;
            }
        });
    }

    // --- Function to load an individual sub-setting's checked state ---
    function loadIndividualSubSettingState(toggleElement, storageKey, defaultValue) {
        if (chrome.storage && chrome.storage.local && toggleElement && !toggleElement.disabled) {
            chrome.storage.local.get([storageKey], result => {
                if (chrome.runtime.lastError) {
                    console.error(`Error loading ${storageKey}:`, chrome.runtime.lastError.message);
                    toggleElement.checked = defaultValue; return;
                }
                toggleElement.checked = result[storageKey] === undefined ? defaultValue : result[storageKey];
            });
        } else if (toggleElement && !toggleElement.disabled) {
            toggleElement.checked = defaultValue;
        }
    }

    // --- Function to handle enabling the main extension (from any main toggle or sub-setting) ---
    function setMainExtensionState(isEnabled, sourceToggle) {
        // Update both main toggles
        if (enableExtensionToggle && sourceToggle !== enableExtensionToggle) enableExtensionToggle.checked = isEnabled;
        if (enableExtensionToggleSettings && sourceToggle !== enableExtensionToggleSettings) enableExtensionToggleSettings.checked = isEnabled;

        if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ extensionEnabled: isEnabled });
        }
        updateSubSettingsAvailability(isEnabled);
        if (isEnabled) {
            loadIndividualSubSettingState(enableClipboardMonToggle, 'clipboardMonitoringEnabled', true);
            loadIndividualSubSettingState(enablePhishletMonToggle, 'phishletMonitoringEnabled', false);
        }
    }

    // --- Load initial settings and stats ---
    function loadData() {
        if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(
                ['extensionEnabled', 'clipboardMonitoringEnabled', 'phishletMonitoringEnabled', 'scannedEntries', 'maliciousFound'],
                result => {
                    if (chrome.runtime.lastError) {
                        console.error("Error loading data:", chrome.runtime.lastError.message);
                        setMainExtensionState(true); // Default to on
                        updateStatsDisplay('N/A', 'N/A');
                        if (maliciousPercentageTextEl) maliciousPercentageTextEl.textContent = "Data N/A";
                        return;
                    }

                    const extensionIsEnabled = result.extensionEnabled === undefined ? true : result.extensionEnabled;
                    if (enableExtensionToggle) enableExtensionToggle.checked = extensionIsEnabled;
                    if (enableExtensionToggleSettings) enableExtensionToggleSettings.checked = extensionIsEnabled;

                    updateSubSettingsAvailability(extensionIsEnabled);
                    if (extensionIsEnabled) {
                        loadIndividualSubSettingState(enableClipboardMonToggle, 'clipboardMonitoringEnabled', result.clipboardMonitoringEnabled === undefined ? true : result.clipboardMonitoringEnabled);
                        loadIndividualSubSettingState(enablePhishletMonToggle, 'phishletMonitoringEnabled', result.phishletMonitoringEnabled === undefined ? false : result.phishletMonitoringEnabled);
                    }
                    updateStatsDisplay(result.scannedEntries || 0, result.maliciousFound || 0);
                }
            );
        } else {
            console.warn("chrome.storage.local not available.");
            setMainExtensionState(true); // Default to on
            if (enableClipboardMonToggle) enableClipboardMonToggle.checked = true;
            if (enablePhishletMonToggle) enablePhishletMonToggle.checked = false;
            updateStatsDisplay(0, 0);
        }
    }
    loadData();

    // --- Event Listeners for Main Toggles ---
    [enableExtensionToggle, enableExtensionToggleSettings].forEach(mainToggle => {
        if (mainToggle) {
            mainToggle.addEventListener('change', function () {
                setMainExtensionState(this.checked, this);
            });
        }
    });

    // --- Event Listeners for Sub-Settings ---
    [
        { element: enableClipboardMonToggle, key: 'clipboardMonitoringEnabled' },
        { element: enablePhishletMonToggle, key: 'phishletMonitoringEnabled' }
    ].forEach(setting => {
        if (setting.element) {
            setting.element.addEventListener('change', function () {
                if (this.checked) { // If a sub-setting is turned ON
                    setMainExtensionState(true, null); // Ensure main extension is also ON, pass null as source
                }
                if (chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ [setting.key]: this.checked });
                }
            });
        }
    });

    // --- Listen for storage changes ---
    if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                if (changes.extensionEnabled || changes.clipboardMonitoringEnabled || changes.phishletMonitoringEnabled) {
                    loadData(); // Reload all settings and stats for consistency
                } else if (changes.scannedEntries || changes.maliciousFound) {
                    chrome.storage.local.get(['scannedEntries', 'maliciousFound'], result => {
                        if (chrome.runtime.lastError) return;
                        updateStatsDisplay(result.scannedEntries || 0, result.maliciousFound || 0);
                    });
                }
            }
        });
    }
});
