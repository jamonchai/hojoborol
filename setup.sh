#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NightChannel — Vendor Asset Downloader
# Runs automatically on Render via buildCommand, or manually: bash setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

PUBLIC="./public"
WEBFONTS="$PUBLIC/webfonts"
mkdir -p "$PUBLIC" "$WEBFONTS"

CDN="https://cdnjs.cloudflare.com/ajax/libs"

echo "📦  Downloading vendor assets..."

curl -fsSL "$CDN/bootstrap/5.3.2/css/bootstrap.min.css"            -o "$PUBLIC/bootstrap.min.css"
curl -fsSL "$CDN/bootstrap/5.3.2/js/bootstrap.bundle.min.js"       -o "$PUBLIC/bootstrap.min.js"
curl -fsSL "$CDN/jquery/3.7.1/jquery.min.js"                       -o "$PUBLIC/jquery.min.js"
curl -fsSL "$CDN/moment.js/2.29.4/moment.min.js"                   -o "$PUBLIC/moment.js"
curl -fsSL "$CDN/font-awesome/6.5.0/css/all.min.css"               -o "$PUBLIC/all.css"
curl -fsSL "$CDN/font-awesome/6.5.0/webfonts/fa-solid-900.woff2"   -o "$WEBFONTS/fa-solid-900.woff2"
curl -fsSL "$CDN/font-awesome/6.5.0/webfonts/fa-regular-400.woff2" -o "$WEBFONTS/fa-regular-400.woff2"
curl -fsSL "$CDN/font-awesome/6.5.0/webfonts/fa-brands-400.woff2"  -o "$WEBFONTS/fa-brands-400.woff2"

# Fix Font Awesome webfont paths for local serving
sed -i 's|../webfonts/|webfonts/|g' "$PUBLIC/all.css"

# Copy Socket.io client from installed node_modules (most reliable)
if [ -f "./node_modules/socket.io/client-dist/socket.io.min.js" ]; then
  cp "./node_modules/socket.io/client-dist/socket.io.min.js" "$PUBLIC/socket.io/socket.io.js"
  echo "✅  Socket.io client copied from node_modules."
else
  echo "⚠️   node_modules not found yet — socket.io.js will be served dynamically by the server."
fi

echo ""
echo "✅  Vendor assets ready."
