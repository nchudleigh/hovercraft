#!/usr/bin/env bash
# Upload dist/hovercraft.zip to the Chrome Web Store and submit it for review.
# Needs CWS_PUBLISHER_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (see docs/releasing.md).
set -euo pipefail

EXTENSION_ID=pbemffbaccogejhogjkehhaocjehdiek
ZIP=dist/hovercraft.zip
API=https://chromewebstore.googleapis.com
ITEM=publishers/$CWS_PUBLISHER_ID/items/$EXTENSION_ID

token=$(curl -sf https://oauth2.googleapis.com/token \
  -d client_id="$CWS_CLIENT_ID" -d client_secret="$CWS_CLIENT_SECRET" \
  -d refresh_token="$CWS_REFRESH_TOKEN" -d grant_type=refresh_token |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
auth=(-H "Authorization: Bearer $token")

echo "Uploading $ZIP"
upload=$(curl -s "${auth[@]}" -X POST -T "$ZIP" "$API/upload/v2/$ITEM:upload")
echo "$upload"
state=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("uploadState",""))' "$upload")

# Large uploads finish processing in the background.
for _ in $(seq 30); do
  [ "$state" = UPLOAD_IN_PROGRESS ] || break
  sleep 5
  status=$(curl -s "${auth[@]}" "$API/v2/$ITEM:fetchStatus")
  state=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("lastAsyncUploadState") or d.get("uploadState",""))' "$status")
done
[ "$state" = SUCCEEDED ] || { echo "Upload failed: $state" >&2; exit 1; }

echo "Submitting for review"
curl -sf "${auth[@]}" -X POST "$API/v2/$ITEM:publish"
echo
