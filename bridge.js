// Mirrors the popup toggle onto <html> so card.js, card.css and video.js can see it.
const html = document.documentElement;
const apply = (enabled) => (html.dataset.hovercraft = enabled === false ? 'off' : 'on');

chrome.storage.local.get('enabled', ({ enabled }) => apply(enabled));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) apply(changes.enabled.newValue);
});

// Played here, not in card.js, so X's media CSP doesn't apply. Sound: Beachball's rally.
const partySound = new Audio(chrome.runtime.getURL('sounds/party.mp3'));
partySound.volume = 0.3;
document.addEventListener('hovercraft:party', () => {
  partySound.currentTime = 0;
  partySound.play().catch((err) => console.warn('[hovercraft] party sound', err));
});
