// Mirrors the popup toggle onto <html> so card.js, card.css and video.js can see it.
const apply = (enabled) => (document.documentElement.dataset.hovercraft = enabled === false ? 'off' : 'on');

chrome.storage.local.get('enabled', ({ enabled }) => apply(enabled));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) apply(changes.enabled.newValue);
});
