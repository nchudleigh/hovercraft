// Mirrors popup settings onto <html> so card.js and card.css (page world) can see them.
const html = document.documentElement;
const apply = (enabled) => (html.dataset.hovercraft = enabled === false ? 'off' : 'on');
const applyBlast = (blast) => (html.dataset.hovercraftBlast = blast || 'party');

chrome.storage.local.get(['enabled', 'blast'], ({ enabled, blast }) => { apply(enabled); applyBlast(blast); });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) apply(changes.enabled.newValue);
  if (changes.blast) applyBlast(changes.blast.newValue);
});
