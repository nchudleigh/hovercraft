const toggle = document.getElementById('enabled');

chrome.storage.local.get('enabled', ({ enabled }) => (toggle.checked = enabled !== false));
toggle.addEventListener('change', () => chrome.storage.local.set({ enabled: toggle.checked }));

const blast = document.getElementById('blast');
chrome.storage.local.get('blast', ({ blast: value }) => (blast.value = value || 'party'));
blast.addEventListener('change', () => chrome.storage.local.set({ blast: blast.value }));
