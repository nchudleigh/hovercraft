<div align="center">

<img src="icons/icon128.png" width="96" height="96" alt="Hovercraft icon">

# Hovercraft

**Instant profile hover cards for X.**<br>
No half-second wait, no fade, and the card glides from profile to profile.

<img src="docs/media/demo.gif" width="720" alt="Hovercraft demo: sweeping across avatars in X notifications while the card glides between profiles">

<sub>[Watch the full-quality video](docs/media/demo.mp4)</sub>

</div>

---

## Why

X's hover card waits about 600ms before it shows, fades in, waits again before it hides, and closes and reopens every time you move to the next profile. Sweeping across a row of avatars in your notifications feels like wading through mud.

Hovercraft replaces it with a card that keeps up with your mouse.

## Features

| | |
|---|---|
| ⚡ **Instant** | A slight 150ms delay on the first card so it doesn't pop as you pass by, then every switch is immediate. |
| 🛸 **Glides** | Moving to another profile slides the open card over and swaps its content, so it never closes and reopens. |
| 👋 **Gets out of the way** | Hides the moment you leave, unless you're heading into the card. |
| ✊ **Hold to follow** | Press and hold a profile or its card for a second to follow. The Follow button fills as you hold. |
| 💀 **Hold to block** | Hold the skull on a card for a second to block that account. A red ring fills as you hold; let go early to cancel. Confetti bursts out of their avatar, and on a reply, the reply is removed from the timeline. |
| 🎙️ **Halo 3 multikills** | Chain successful skull blocks in one tab. Each block within ten seconds of the previous one advances the chain, with an announcement from Double Kill (2) through Killionaire (10). A longer gap starts a new chain. |
| 🎙️ **Halo 3 killing sprees** | Successful skull blocks in the same tab count toward Killing Spree (5), Killing Frenzy (10), Running Riot (15), Rampage (20), Untouchable (25), and Invincible (30). The spree has no time limit. Reload the page or turn Hovercraft off to reset it. |
| 🔇 **Mute and block menu** | The ⋯ button on the card mutes or blocks. Block asks for a second click so a stray click can't block anyone. |
| ⏩ **Hold for 2×** | Press and hold a playing video to watch at 2× speed, like the phone app. Let go to return to normal. |
| 📡 **No network wait** | Reads the profile data X already loaded for the page. |
| 🎨 **Native look** | Follow button, verified badges, "Follows you", bio and counts. Matches Light, Dim and Lights out. |

<p align="center"><img src="docs/media/block.gif" width="640" alt="Holding the skull on a reply's hover card: a red ring fills, confetti bursts from the avatar, and the reply disappears"></p>

<p align="center"><a href="docs/media/walkthrough.mp4"><img src="docs/media/walkthrough.jpg" width="640" alt="Walkthrough video: blocking accounts from a post's Likes list with the hover card"></a><br><sub><a href="docs/media/walkthrough.mp4">Watch the walkthrough (with sound)</a></sub></p>

## Install

Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/hovercraft/pbemffbaccogejhogjkehhaocjehdiek). Store installs update automatically.

To run from source instead:

1. Clone this repo, or download it as a ZIP and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repo folder.
4. Refresh X.

Works in Chrome and other Chromium browsers (Arc, Brave, Edge, Helium, …).

## Settings

Click the Hovercraft icon in the toolbar to turn it off and bring back X's own hover card.

## How it works

- `card.css` hides X's native hover card.
- `card.js` runs in the page so it can read X's React data for the hovered profile, then draws its own card in a shadow root.
- Follow, mute and block call X's API with your existing session. If a block fails, the removed reply comes back.
- `bridge.js` passes the on/off setting to the page, tracks confirmed skull blocks, and plays the confetti and announcer sounds in the extension context so X's media restrictions don't block playback.
- `video.js` handles hold-for-2× on videos.
- The confetti and its sound come from Beachball: a canvas port of its confetti burst and its rally sound (`sounds/party.mp3`).

## Tweaking

Everything lives at the top of `card.js`:

| Setting | Default | What it does |
|---|---|---|
| `FIRST_REVEAL_MS` | `150` | Delay before the first card appears |
| `WARM_MS` | `300` | Re-hover within this long after a hide and the card shows instantly |
| `GLIDE` | `200ms` ease-out cubic | How the card slides between profiles |
| `HIDE_GRACE_MS` | `100` | Grace period while crossing into the card or to a neighboring profile |
| `NEAR_PX` | `16` | How far from a profile still counts as "between profiles" |
| `HOLD_MS` | `1000` | How long to hold to follow or to block with the skull |

Colors are CSS variables (`--bg`, `--stroke`, `--outer`, …) in the same file.

## Caveats

X changes its markup and data often, so this can break. If a card doesn't show for someone, check the console for `[x-hovercard]` messages and [open an issue](https://github.com/nchudleigh/hovercraft/issues).

A blocked reply is only removed from the page you're on. After a reload, X decides whether to show it.

## Privacy

No data is collected or sent anywhere. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE) for the code. See the [audio credits](sounds/NOTICE.md) for the Halo 3 recordings.
