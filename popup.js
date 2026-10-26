const toggle = document.getElementById('enabled');

chrome.storage.local.get('enabled', ({ enabled }) => (toggle.checked = enabled !== false));
toggle.addEventListener('change', () => chrome.storage.local.set({ enabled: toggle.checked }));
