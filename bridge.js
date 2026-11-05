// Mirrors the popup toggle onto <html> so card.js, card.css and video.js can see it.
const html = document.documentElement;

// Played here, not in card.js, so X's media CSP doesn't apply. Sound: Beachball's rally.
const partySound = new Audio(chrome.runtime.getURL('sounds/party.mp3'));
partySound.volume = 0.3;
document.addEventListener('hovercraft:party', () => {
  partySound.currentTime = 0;
  partySound.play().catch((err) => console.warn('[hovercraft] party sound', err));
});

const MULTIKILL_MS = 4000;
const multikillSounds = [
  'double_kill', 'triple_kill', 'overkill', 'killtacular', 'killtrocity',
  'killimanjaro', 'killtastrophe', 'killpocalypse', 'killionaire',
];
let lastBlock = -Infinity;
let blockCount = 0;
let announcer = null;
const pendingAnnouncements = [];

function playAnnouncement() {
  if (announcer || !pendingAnnouncements.length) return;
  const sound = pendingAnnouncements.shift();
  const clip = new Audio(chrome.runtime.getURL(`sounds/${sound}.mp3`));
  announcer = clip;
  clip.volume = 0.6;
  const finish = () => {
    if (announcer !== clip) return;
    announcer = null;
    playAnnouncement();
  };
  clip.addEventListener('ended', finish, { once: true });
  clip.addEventListener('error', finish, { once: true });
  clip.play().catch(finish);
}

document.addEventListener('hovercraft:skull-blocked', () => {
  if (html.dataset.hovercraft === 'off') return;
  const now = performance.now();
  blockCount = now - lastBlock <= MULTIKILL_MS ? blockCount + 1 : 1;
  lastBlock = now;
  const sound = multikillSounds[blockCount - 2];
  if (!sound) return;
  pendingAnnouncements.push(sound);
  playAnnouncement();
});

function apply(enabled) {
  html.dataset.hovercraft = enabled === false ? 'off' : 'on';
  if (enabled === false) {
    lastBlock = -Infinity;
    pendingAnnouncements.length = 0;
    announcer?.pause();
    announcer = null;
  }
}

chrome.storage.local.get('enabled', ({ enabled }) => apply(enabled));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) apply(changes.enabled.newValue);
});
