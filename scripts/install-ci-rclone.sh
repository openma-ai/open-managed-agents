#!/usr/bin/env bash
# Match the native-storage protocol exercised locally; Ubuntu's packaged rclone
# predates the Unix RC/VFS queue contract used by the production drain.
set -euo pipefail
archive=$(mktemp -d)
trap 'rm -rf "$archive"' EXIT
curl --fail --location --retry 3 --output "$archive/rclone.zip" \
  https://downloads.rclone.org/v1.74.1/rclone-v1.74.1-linux-amd64.zip
printf '%s  %s\n' 67df3059a6233b6e32e604bcd637654bb294ff86291b65ede77123e94818d911 "$archive/rclone.zip" | sha256sum --check -
unzip -q "$archive/rclone.zip" -d "$archive"
sudo install -m 0755 "$archive/rclone-v1.74.1-linux-amd64/rclone" /usr/local/bin/rclone
rclone version
