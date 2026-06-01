#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

node -v
npm -v

runuser -u ubuntu renovate
