# Hovercraft

A Chrome extension that replaces X's profile hover card with one that's instant.

- Shows the moment you hover a profile. No 600ms wait, no fade.
- Hides the moment you leave, unless you're moving into the card.
- Glides between profiles instead of closing and reopening, so you can sweep across a row of avatars.
- Uses data X already loaded for the page, so there's no network wait.

The card shows the avatar, a Follow button, name and verified badge, "Follows you", bio, follower counts and "Followed by…". It matches X's Light, Dim and Lights out themes.

## Install

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repo folder.
4. Refresh X.

## How it works

- `card.css` hides X's native hover card.
- `card.js` runs in the page so it can read X's React data for the hovered profile, then draws its own card in a shadow root.
- The "Followed by" row reuses the request X's hidden native card still makes.
- Follow/unfollow calls X's API with your existing session.

Tweak timings and colors at the top of `card.js` (`GLIDE`, `HIDE_GRACE_MS`, `NEAR_PX`, and the CSS variables).

## Caveats

X changes its markup and data shapes often, so this can break. If a card doesn't show for someone, check the console for `[x-hovercard] no user data for <handle>`.

## License

MIT
