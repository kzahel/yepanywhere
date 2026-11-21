#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPException
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import quote, urlencode, urlsplit
from uuid import uuid4


SERVER = "/v0/servers/self"
ACTIVE_STATES = {"idle", "in-turn", "waiting-input", "compacting"}
GENERAL_BUCKETS = {"codex:primary", "codex:secondary"}


class ApiError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f"YA HTTP {status} ({code or 'unknown error'})")
        self.code = code


def log(message):
    print(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {message}", flush=True)


def codex_quota(args):
    command = args.aar or ["aar"]
    started_at = datetime.now(timezone.utc)
    result = subprocess.run(
        [*command, "--state", str(args.aar_state), "account", "quotas", args.account],
        capture_output=True, check=False, timeout=45,
    )
    if result.returncode:
        raise RuntimeError(f"AAR quota read failed (exit {result.returncode})")
    snapshots = json.loads(result.stdout)
    snapshot, = snapshots
    if (snapshot["accountId"] != args.account or snapshot["provider"] != "codex"
            or snapshot["status"] != "ok"):
        raise RuntimeError("AAR did not return a quota for the selected Codex account")
    observed_at = datetime.fromisoformat(snapshot["observedAt"].replace("Z", "+00:00"))
    clock_tolerance = timedelta(seconds=5)
    if not started_at - clock_tolerance <= observed_at <= datetime.now(timezone.utc) + clock_tolerance:
        raise RuntimeError("AAR did not return a fresh quota observation")
    windows = {}
    for window in snapshot["windows"]:
        remaining = window.get("remainingPercent")
        if (window["bucket"] in GENERAL_BUCKETS and type(remaining) in (int, float)
                and 0 <= remaining <= 100):
            minutes = window.get("windowMinutes")
            label = {300: "5-hour", 10080: "weekly"}.get(minutes, window["bucket"])
            windows[window["bucket"]] = (label, remaining)
    permission = snapshot.get("ordinaryUsageAllowed")
    if permission is not None and not isinstance(permission, bool):
        raise RuntimeError("AAR returned an invalid included-usage flag")
    if not windows and permission is None:
        raise RuntimeError("AAR returned no usable account-wide quota evidence")
    exhausted = permission is False or (
        permission is None and any(remaining == 0 for _, remaining in windows.values())
    )
    summary = ", ".join(f"{label} {percent:g}% left" for label, percent in windows.values())
    if permission is not None:
        allowance = "allowed" if permission else "denied"
        summary = ", ".join(filter(None, [summary, f"included usage {allowance}"]))
    log(f"Codex quota: {summary}")
    return exhausted


def ya_api(args):
    instance = json.loads(args.ya_instance.read_text())
    url = urlsplit(instance["url"])
    if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1", "localhost"}
            or not url.port or url.username is not None or url.password is not None
            or url.path not in {"", "/"} or url.query or url.fragment):
        raise RuntimeError("Expected a loopback HTTP URL in the YA instance record")

    def request(path, request_id=None):
        headers = {"X-Yep-Anywhere": "true"}
        method, body = "GET", None
        if request_id:
            method, body = "POST", "{}"
            headers.update({"Idempotency-Key": request_id, "Content-Type": "application/json"})
        connection = HTTPConnection(url.hostname, url.port, timeout=10)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            data = json.loads(response.read())
            if not 200 <= response.status < 300:
                error = data.get("error")
                raise ApiError(response.status, error.get("code") if isinstance(error, dict) else None)
            return data
        finally:
            connection.close()

    identity = request("/v0/me")
    access = request(f"{SERVER}/access")
    capabilities = request(f"{SERVER}/capabilities")
    required = {"sessions", "stop", "receipt"}
    if (identity["server"]["id"] != args.server_id or identity["session"] is not None
            or access["scope"] != "all-projects" or access["principal"]["kind"] != "superuser"
            or not required <= set(access["operations"]) & set(capabilities["operations"])):
        raise RuntimeError("Expected the configured YA server and all-project operator stop access")
    return request


def active_sessions(request):
    active = set()
    cursor = None
    while True:
        query = {"limit": 100}
        if cursor is not None:
            query["cursor"] = cursor
        page = request(f"{SERVER}/sessions?{urlencode(query)}")
        active.update(item["id"] for item in page["items"] if item["state"] in ACTIVE_STATES)
        next_cursor = page["nextCursor"]
        if next_cursor is None:
            return sorted(active)
        if (not isinstance(next_cursor, str) or not next_cursor.isdecimal()
                or int(next_cursor) <= int(cursor or 0)):
            raise RuntimeError("YA returned an invalid session cursor")
        cursor = next_cursor


def stop_session(request, session_id):
    request_id = f"codex-quota-{uuid4()}"
    log(f"Stopping {session_id} (request {request_id})")
    try:
        receipt = request(f"{SERVER}/sessions/{quote(session_id, safe='')}/stop", request_id)
        receipt_path = f"{SERVER}/receipts/{quote(receipt['id'], safe='')}"
        deadline = time.monotonic() + 35
        while receipt["state"] in {"dispatching", "queued"} and time.monotonic() < deadline:
            time.sleep(1)
            receipt = request(receipt_path)
        if receipt["requestId"] != request_id or receipt["kind"] != "stop":
            raise RuntimeError(f"unexpected stop receipt {receipt['id']}")
        if receipt.get("failure", {}).get("code") == "session_not_running":
            log(f"{session_id} already stopped (receipt {receipt['id']})")
        elif receipt["state"] == "accepted" and receipt.get("result", {}).get("verifiedStopped") is True:
            log(f"Verified stop of {session_id} (receipt {receipt['id']})")
        else:
            raise RuntimeError(f"stop unverified (receipt {receipt['id']}: {receipt['state']})")
    except ApiError as error:
        if error.code == "session_not_running":
            log(f"{session_id} no longer active ({error.code})")
        else:
            log(f"{session_id}: {error}")
            return False
    except (OSError, HTTPException, RuntimeError, ValueError, KeyError, TypeError) as error:
        log(f"{session_id}: {error}")
        return False
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Check AAR Codex quota once, for use from a five-minute scheduler."
    )
    parser.add_argument("--account", required=True, help="AAR Codex enrollment id")
    parser.add_argument("--aar-state", type=Path, default=Path.home() / ".agent-auth-router")
    parser.add_argument(
        "--ya-instance", type=Path, default=Path.home() / ".yep-anywhere/server-instance.json"
    )
    parser.add_argument("--server-id", required=True, help="Expected local YA server id from /v0/me")
    parser.add_argument(
        "--apply", action="store_true", help="Stop all active local YA sessions when exhausted"
    )
    parser.add_argument("aar", nargs="*", help="AAR command after -- (default: aar)")
    args = parser.parse_args()
    try:
        exhausted = codex_quota(args)
        request = ya_api(args)
        if not exhausted:
            return 0
        sessions = active_sessions(request)
        action = "Stopping" if args.apply else "Would stop"
        log(f"Codex quota exhausted. {action} {len(sessions)} active YA sessions.")
        if args.apply and sessions:
            with ThreadPoolExecutor(max_workers=8) as pool:
                outcomes = list(pool.map(lambda session: stop_session(request, session), sessions))
                return 0 if all(outcomes) else 1
    except (OSError, HTTPException, RuntimeError, ValueError, KeyError, TypeError,
            subprocess.TimeoutExpired) as error:
        log(f"Watchdog check failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
