#!/usr/bin/env bash
# Health check for a VSS server running lightningdevkit/vss-server with
# sigs-auth (--features sigs), as used by rgb-lightning-node.
#
# Usage: ./vss-check.sh [base-url]
#        ./vss-check.sh https://vss-server.utexo.com/vss     (default)
#        ./vss-check.sh http://127.0.0.1:8181/vss
#
# Needs only python3 + curl. It generates a throwaway keypair, so it reads a
# store_id that has never existed. Read-only: no data is ever written.
set -u

BASE="${1:-https://vss-server.utexo.com/vss}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP" <<'PY'
import hashlib, os, sys

P  = 2**256 - 2**32 - 977
N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

def add(a, b):
    if a is None: return b
    if b is None: return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0: return None
    if a == b: l = 3 * a[0] * a[0] * pow(2 * a[1], P - 2, P)
    else:      l = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P)
    x = (l * l - a[0] - b[0]) % P
    return (x, (l * (a[0] - x) - a[1]) % P)

def mul(k, pt=(GX, GY)):
    r = None
    while k:
        if k & 1: r = add(r, pt)
        pt = add(pt, pt); k >>= 1
    return r

# throwaway key
d = int.from_bytes(os.urandom(32), 'big') % N or 1
Q = mul(d)
pub = bytes([2 + (Q[1] & 1)]) + Q[0].to_bytes(32, 'big')

SALT = b'VSS Signature Authorizer Signing Salt Constant..................'
now  = str(int(__import__('time').time())).encode()
z    = int.from_bytes(hashlib.sha256(SALT + pub + now).digest(), 'big')

while True:                                  # ECDSA, low-S (libsecp256k1 rejects high-S)
    k = int.from_bytes(os.urandom(32), 'big') % N
    if not k: continue
    R = mul(k); r = R[0] % N
    if not r: continue
    s = (pow(k, N - 2, N) * (z + r * d)) % N
    if not s: continue
    if s > N // 2: s = N - s
    break

store_id = pub.hex()
token = store_id + r.to_bytes(32, 'big').hex() + s.to_bytes(32, 'big').hex() + now.decode()

def field(tag, text):                        # protobuf: length-delimited string
    b = text.encode(); out = bytearray([tag]); n = len(b)
    while n > 127: out.append((n & 0x7f) | 0x80); n >>= 7
    out.append(n); return bytes(out) + b

tmp = sys.argv[1]
open(f'{tmp}/token', 'w').write(token)
open(f'{tmp}/store', 'w').write(store_id)
# GetObjectRequest{store_id=1, key=2}
open(f'{tmp}/get.bin', 'wb').write(field(0x0a, store_id) + field(0x12, '__rln_instance__'))
# ListKeyVersionsRequest{store_id=1}
open(f'{tmp}/list.bin', 'wb').write(field(0x0a, store_id))
PY

TOKEN="$(cat "$TMP/token")"

echo "VSS server : $BASE"
echo "store_id   : $(cut -c1-20 < "$TMP/store")…  (throwaway key, never existed)"
echo

probe() {  # name, path, body-file
  printf '%-18s ' "$1"
  local code body
  code=$(curl -s --max-time 20 -o "$TMP/resp" -w '%{http_code}' -X POST "$BASE$2" \
         -H "Authorization: $TOKEN" \
         -H 'Content-Type: application/octet-stream' \
         --data-binary "@$3")
  body=$(tr -d '\000-\037' < "$TMP/resp")
  printf 'HTTP %-4s %s\n' "$code" "$body"
}

printf '%-18s ' 'no-auth'
curl -s --max-time 20 -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE/getObject" \
     -H 'Content-Type: application/octet-stream' --data-binary ''

probe 'getObject'       '/getObject'       "$TMP/get.bin"
probe 'listKeyVersions' '/listKeyVersions' "$TMP/list.bin"

cat <<'EXPECTED'

Healthy server:
  no-auth          HTTP 401   Authorization header not found.
  getObject        HTTP 404   Requested key not found.      (NoSuchKeyException, code 4)
  listKeyVersions  HTTP 200   (empty)

HTTP 500 "Unknown Server Error occurred." (InternalServerException, code 3) on a
throwaway store_id means the storage layer is failing, not auth and not the
client: sigs-auth is stateless and never touches the database, which is why the
401 still answers correctly while every read 500s. Check the vss-server
container logs, Postgres reachability/credentials, and whether the schema was
applied.
EXPECTED
