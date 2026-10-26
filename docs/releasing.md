# Releasing

Store installs update on their own once a new version passes Chrome Web Store review.

## Ship a version

Locally:

```sh
make release V=2.2.0
```

Or from CI: commit the version bump, then push a tag. The tag sets the version in the uploaded zip.

```sh
make version V=2.2.0 && git commit -am "Release 2.2.0"
git tag v2.2.0 && git push --follow-tags
```

The version must be higher than the one live on the store.

## One-time setup

1. **Publisher ID:** Developer Dashboard → Publisher → Settings.
2. **Google Cloud:** create a project, enable the *Chrome Web Store API*, set up an External OAuth consent screen, and create a *Web application* OAuth client with redirect URI `https://developers.google.com/oauthplayground`.
3. **Refresh token:** in the [OAuth Playground](https://developers.google.com/oauthplayground), click the gear, tick *Use your own OAuth credentials*, enter the client ID/secret, authorize scope `https://www.googleapis.com/auth/chromewebstore` with the account that owns the extension, then exchange the code for tokens.
4. Put the four values in `.env` (gitignored) and in the repo's GitHub Actions secrets:

```sh
CWS_PUBLISHER_ID=...
CWS_CLIENT_ID=...
CWS_CLIENT_SECRET=...
CWS_REFRESH_TOKEN=...
```

Publish the OAuth consent screen to *In production*. In *Testing*, refresh tokens expire after 7 days.

API reference: https://developer.chrome.com/docs/webstore/using-api
