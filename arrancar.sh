#!/bin/sh
# arrancar.sh <imagen>  — (re)crea el contenedor amalia-events-mcp con el entorno de /home/ec2-user/amalia-events.env (chmod 600, fuera del repo).
set -e
IMG="${1:?uso: arrancar.sh amalia-events-mcp:<etiqueta>}"
ENV_FILE="${AMALIA_ENV_FILE:-/home/ec2-user/amalia-events.env}"
[ -r "$ENV_FILE" ] || { echo "No existe $ENV_FILE" >&2; exit 1; }
docker rm -f amalia-events-mcp-prev >/dev/null 2>&1 || true
if docker inspect amalia-events-mcp >/dev/null 2>&1; then docker rename amalia-events-mcp amalia-events-mcp-prev; docker stop amalia-events-mcp-prev >/dev/null; fi
docker run -d --name amalia-events-mcp --network host --env-file "$ENV_FILE" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user node --cap-drop ALL --security-opt no-new-privileges --memory 320m --memory-swap 448m --pids-limit 64 --cpus 0.5 --restart on-failure:5 \
  -v /etc/amalia-events-mcp/kalma-bridge.key:/run/secrets/kalma-bridge.key:ro -v /var/lib/amalia-events-data:/data \
  -v /etc/amalia-events-mcp/firebase.json:/run/secrets/firebase.json:ro -v /etc/amalia-events-mcp/access.json:/run/secrets/access.json:ro \
  -v /etc/amalia-events-mcp/publishing.json:/run/secrets/publishing.json:ro "$IMG"
