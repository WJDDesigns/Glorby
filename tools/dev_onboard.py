"""Set up the throwaway local Home Assistant in .ha-dev and print an access token file."""
import json
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://localhost:8123"
CLIENT = f"{BASE}/"
DEV = Path(__file__).parents[1] / ".ha-dev"
CREDS = DEV / "dev-login.json"


def call(path, data=None, token=None, form=False):
    headers = {}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


for _ in range(120):
    try:
        status = call("/api/onboarding")
        break
    except (urllib.error.URLError, ConnectionError):
        time.sleep(2)
else:
    sys.exit("Home Assistant did not start")

done = {s["step"] for s in status if s["done"]}
if "user" not in done:
    password = secrets.token_urlsafe(18)
    result = call(
        "/api/onboarding/users",
        {"client_id": CLIENT, "name": "Dev", "username": "dev", "password": password, "language": "en"},
    )
    CREDS.write_text(json.dumps({"username": "dev", "password": password}))
    tokens = call(
        "/auth/token",
        {"grant_type": "authorization_code", "code": result["auth_code"], "client_id": CLIENT},
        form=True,
    )
    token = tokens["access_token"]
    call("/api/onboarding/core_config", {}, token)
    call("/api/onboarding/analytics", {}, token)
    call("/api/onboarding/integration", {"client_id": CLIENT, "redirect_uri": CLIENT}, token)
    CREDS.write_text(json.dumps({"username": "dev", "password": password, "refresh_token": tokens["refresh_token"]}))
creds = json.loads(CREDS.read_text())
tokens = call("/auth/token", {"grant_type": "refresh_token", "refresh_token": creds["refresh_token"], "client_id": CLIENT}, form=True)
token = tokens["access_token"]

entries = call("/api/config/config_entries/entry", token=token)
if not any(e["domain"] == "glorb" for e in entries):
    flow = call("/api/config/config_entries/flow", {"handler": "glorb", "show_advanced_options": False}, token)
    result = call(f"/api/config/config_entries/flow/{flow['flow_id']}", {"host": sys.argv[1]}, token)
    print("flow:", result.get("type"), result.get("title"), result.get("errors"))
print("entries:", [e["domain"] for e in call("/api/config/config_entries/entry", token=token) if e["domain"] == "glorb"])
for state in call("/api/states", token=token):
    if state["entity_id"].startswith("light."):
        print(state["entity_id"], state["state"], {k: v for k, v in state["attributes"].items() if k != "effect_list"})
