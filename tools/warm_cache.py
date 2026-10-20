"""Pre-fill the server's cache for every built-in candidate place.

The candidate list is what most people use, so this asks a running server for the same three
things the page asks for when you pick a candidate (the detailed area, the elevation grid and the
surroundings). The server stores each answer in its memory and disk cache, so the first real visit
is instant and survives a restart (the cache volume lives in /data in Docker).

Usage:
    python tools/warm_cache.py                           # all candidates, 300 m area, 2 km surroundings
    python tools/warm_cache.py --url http://host:8080    # another server
    python tools/warm_cache.py --size 300,600 --far 2,4  # several area sizes / surroundings
    python tools/warm_cache.py --group Japan             # only one region (see the page's groups)
    python tools/warm_cache.py --only tokyo --limit 5    # a name filter, and a cap for a quick test

It is safe to stop (Ctrl+C) and run again: places that are already cached answer in milliseconds,
and only the missing ones go to Overpass. Requests that really hit Overpass are spaced by --delay
seconds so the public servers are not hammered. Cached data expires after OSM_TTL (7 days by
default), so run it again about weekly, for example from cron or a scheduled task.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# A response faster than this came from the server's cache, so no pause is needed after it.
CACHED_UNDER_SECONDS = 0.6


def get(url, timeout):
    """GET url and return (status, parsed JSON or None, seconds)."""
    started = time.monotonic()
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            status = resp.status
    except urllib.error.HTTPError as err:
        body = err.read()
        status = err.code
    took = time.monotonic() - started
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    return status, data, took


def fetch_with_retries(url, timeout, retries, delay):
    """Return (ok, seconds, message). Retries transient failures with a growing pause."""
    total = 0.0
    message = ""
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(delay * (attempt + 1) * 2)
        try:
            status, data, took = get(url, timeout)
        except (urllib.error.URLError, OSError) as err:
            total += timeout
            message = str(err)
            continue
        total += took
        if status == 200:
            return True, total, ""
        message = "HTTP %d%s" % (status, (": " + str(data.get("error"))) if isinstance(data, dict) and data.get("error") else "")
        if status < 500 and status != 429:
            break  # a bad request will not get better by retrying
    return False, total, message


def main():
    ap = argparse.ArgumentParser(description="Pre-fill the server cache for all candidate places.")
    ap.add_argument("--url", default="http://localhost:8080", help="server base URL (default %(default)s)")
    ap.add_argument("--size", default="300", help="area sizes in metres, comma separated (200,300,400,600,800,1000)")
    ap.add_argument("--far", default="2", help="surroundings in km, comma separated: 0 (none), 2 or 4")
    ap.add_argument("--group", default="", help="only places whose region contains this text")
    ap.add_argument("--only", default="", help="only places whose name contains this text")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many places (0 = all)")
    ap.add_argument("--delay", type=float, default=1.0, help="pause in seconds after a request that reached Overpass")
    ap.add_argument("--retries", type=int, default=2, help="retries per request on a server error")
    ap.add_argument("--timeout", type=float, default=150.0, help="seconds to wait for one request")
    args = ap.parse_args()

    base = args.url.rstrip("/")
    sizes = [int(x) for x in args.size.split(",") if x.strip()]
    fars = [int(x) for x in args.far.split(",") if x.strip()]
    for far in fars:
        if far not in (0, 2, 4):
            ap.error("--far must be 0, 2 or 4")

    try:
        status, places, _ = get(base + "/api/places", 30)
    except (urllib.error.URLError, OSError) as err:
        print("Cannot reach %s: %s" % (base, err))
        return 2
    if status != 200 or not isinstance(places, list):
        print("Unexpected answer from /api/places (HTTP %d)" % status)
        return 2

    needle = args.only.lower()
    group = args.group.lower()
    places = [p for p in places
              if needle in p["name"].lower() and group in (p.get("group") or "").lower()]
    if args.limit > 0:
        places = places[:args.limit]
    if not places:
        print("No place matches the filters.")
        return 1

    jobs_per_place = sum(1 + (2 if far else 1) for far in fars) * len(sizes)
    print("Warming %d places at %s (%d requests each at most)" % (len(places), base, jobs_per_place))

    failures = []
    started = time.monotonic()
    try:
        for i, p in enumerate(places, 1):
            lat, lon = p["lat"], p["lon"]
            results = []
            for size in sizes:
                urls = [("city", "%s/api/city?%s" % (base, urllib.parse.urlencode(
                    {"lat": lat, "lon": lon, "size": size, "seed": 0})))]
                for far in fars:
                    # The same grid the page asks for: the surroundings area when there is one, else the area.
                    elev = {"lat": lat, "lon": lon, "size": far * 1000 if far else size, "n": 161 if far else 129}
                    urls.append(("elevation", "%s/api/elevation?%s" % (base, urllib.parse.urlencode(elev))))
                    if far:
                        urls.append(("surroundings", "%s/api/surroundings?%s" % (base, urllib.parse.urlencode(
                            {"lat": lat, "lon": lon, "size": size, "far": far * 1000}))))
                seen = set()
                for kind, url in urls:
                    if url in seen:
                        continue
                    seen.add(url)
                    ok, took, msg = fetch_with_retries(url, args.timeout, args.retries, args.delay)
                    results.append("%s %s %.1fs" % (kind, "ok" if ok else "FAILED", took))
                    if not ok:
                        failures.append("%s (%s, size %d): %s" % (p["name"], kind, size, msg))
                    if took >= CACHED_UNDER_SECONDS:
                        time.sleep(args.delay)
            print("[%d/%d] %s: %s" % (i, len(places), p["name"], ", ".join(results)))
            sys.stdout.flush()
    except KeyboardInterrupt:
        print("Stopped. Run it again to continue; finished places are already cached.")

    print("Done in %.0fs. %d problem(s)." % (time.monotonic() - started, len(failures)))
    for line in failures:
        print("  - " + line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
