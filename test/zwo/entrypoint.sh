#!/bin/sh
# Start the fake firmware, then the server from a copy of the telescope's /etc/zwo/Alpaca
# (mounted read-only at /seestar-alpaca).
set -e

mkdir -p /tmp/zwo/log/Alpaca/Seestar /app

# On the telescope the directory carries its own runtime for its own CPU. Take only the assemblies
# the official runtime does not already provide, and run the server framework-dependent instead.
for file in /seestar-alpaca/*; do
	name=$(basename "$file")
	case "$name" in
		*.so | ascom.alpaca | createdump | ascom.alpaca.deps.json) continue ;;
	esac
	if [ "${name%.dll}" != "$name" ] && ls /usr/share/dotnet/shared/*/8.*/"$name" >/dev/null 2>&1; then
		continue
	fi
	cp -r "$file" /app/
done

cat > /app/ascom.alpaca.runtimeconfig.json <<'JSON'
{
  "runtimeOptions": {
    "tfm": "net8.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "8.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "8.0.0" }
    ],
    "configProperties": {
      "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": true
    }
  }
}
JSON

# ALPACA_PASSWORD turns on the server's "Require Authorization", as its settings page would.
if [ -n "$ALPACA_PASSWORD" ]; then
	node /stand/settings.mjs "${ALPACA_USERNAME:-User}" "$ALPACA_PASSWORD" /home/pi/ascom/server/v1/instance-0.xml
fi

node /stand/firmware.mjs 4700 &
# The firmware must be listening before the server boots: it connects once, at startup.
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if node -e "require('net').connect(4700,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then break; fi
	sleep 0.2
done

cd /app
# No arguments: the server dereferences its logger before initialising it when given any.
exec dotnet ascom.alpaca.dll
