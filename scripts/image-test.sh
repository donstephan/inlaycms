#!/usr/bin/env bash
# Builds the Inlay image and drives the docker/inlaycms wrapper, installed from the image, against a fresh copy of
# example/ with no node_modules: as a site on a computer with Docker and no Node would use it. Needs Docker and bash.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
image=inlaycms-image-test
port=3198
dev=inlaycms-image-test-dev
work=$(mktemp -d)
site=$work/site

cleanup() {
  docker rm -f "$dev" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1"
  docker logs "$dev" 2>&1 | tail -20 || true
  exit 1
}

# GET http://127.0.0.1:$port$1 through bash's /dev/tcp, so the test needs no curl.
get() {
  exec 3<>"/dev/tcp/127.0.0.1/$port" || return 1
  printf 'GET %s HTTP/1.0\r\nHost: localhost:%s\r\n\r\n' "$1" "$port" >&3
  cat <&3
  exec 3<&-
}

# Waits up to 60 s for `get /` to answer and contain $1.
wait_for() {
  for _ in $(seq 1 120); do
    if get / 2>/dev/null | grep -q "$1"; then return 0; fi
    sleep 0.5
  done
  return 1
}

echo "Building the image..."
docker build -q -t "$image" "$root" >/dev/null

mkdir -p "$site" "$work/bin"
(cd "$root/example" && tar --exclude=./data -cf - .) | (cd "$site" && tar -xf -)
cat >"$site/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "inlaycms",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.ts", "*.tsx"]
}
EOF
docker run --rm "$image" cat /opt/inlaycms/wrapper/inlaycms >"$work/bin/inlaycms"
chmod +x "$work/bin/inlaycms"
export PATH="$work/bin:$PATH" INLAY_IMAGE=$image
cd "$site"

inlaycms check >/dev/null || fail 'check'
pass 'check'

inlaycms keygen --out keys --name release >/dev/null || fail 'keygen'
[ -O keys/release.key ] || fail 'keygen: keys/release.key should belong to you'
pass 'keygen'

echo 'export const broken: number = "not a number"' >broken.ts
if inlaycms pack --key keys/release.key --out release.tgz >"$work/out" 2>&1; then fail 'pack refuses a type error'; fi
grep -q 'type errors' "$work/out" || fail "pack refuses a type error: $(cat "$work/out")"
rm broken.ts
pass 'pack refuses a type error'

inlaycms pack --key keys/release.key --out release.tgz >/dev/null || fail 'pack'
[ -O release.tgz ] || fail 'pack: release.tgz should belong to you'
pass 'pack'

INLAY_DOCKER_ARGS="--name $dev" inlaycms dev --port "$port" >"$work/dev.log" 2>&1 &
wait_for 'Websites that stay simple' || fail 'dev serves the site on the published port'
[ -O data/inlay.db ] || fail 'dev keeps its database in the site folder'
pass 'dev serves the site, with its data in the site folder'

sed 's|<h1|<h1 data-image-test="edited"|' site.tsx >site.tsx.new && mv site.tsx.new site.tsx
wait_for 'data-image-test="edited"' || fail 'dev restarts on an edit'
pass 'dev restarts on an edit'

docker stop "$dev" >/dev/null
printf 'image-test-password-123\n' | inlaycms create-owner --email owner@example.com --name Owner >/dev/null || fail 'create-owner'
pass 'create-owner reads the password from stdin'

echo 'All image tests passed.'
