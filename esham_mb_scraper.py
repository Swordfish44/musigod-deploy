"""
MusiGod — Esham MusicBrainz Catalog Scraper v2
===============================================
Uses MB *browse* API (not search) — correct approach for pulling
all recordings/works by a known artist MBID.

Run: python esham_mb_scraper.py
Output: esham_mb_catalog.json + esham_mb_report.txt

Rate limit: 1 req/sec enforced via sleep(1)
"""

import json
import time
import urllib.request
import urllib.parse
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────────
USER_AGENT  = "MusiGod/1.0 (musigod.com; support@musigod.com)"
MB_BASE     = "https://musicbrainz.org/ws/2"
ARTIST_MBID = "25bac939-a1ad-406f-9e00-584afd47dbfe"  # Confirmed: Esham (Smith Esham A)
ARTIST_NAME = "Esham"

# Known ASCAP works from June 17 session (ISWC → title)
ASCAP_KNOWN = {
    "T3093127647": "DANCE WITH THE DEVIL",
    "T9300625687": "KIL",
}


# ── HTTP helper ──────────────────────────────────────────────────────────────
def mb_get(endpoint, params):
    """Browse MB API — endpoint is bare (e.g. 'recording', 'work')."""
    qs  = urllib.parse.urlencode(params)
    url = f"{MB_BASE}/{endpoint}?{qs}&fmt=json"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        time.sleep(1)
        return data
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  HTTP {e.code} on {url}")
        print(f"  Response: {body[:300]}")
        raise


# ── Step 1: Fetch recordings (browse API) ───────────────────────────────────
def fetch_recordings(mbid):
    print(f"\n[1/3] Fetching recordings for {ARTIST_NAME} ({mbid})...")
    recordings = []
    offset = 0
    limit  = 100

    while True:
        data  = mb_get("recording", {"artist": mbid, "limit": limit, "offset": offset, "inc": "isrcs"})
        batch = data.get("recordings", [])
        recordings.extend(batch)
        total = data.get("recording-count", len(recordings))
        print(f"  {len(recordings)}/{total}...")
        if len(batch) < limit or len(recordings) >= total:
            break
        offset += limit

    print(f"  Done — {len(recordings)} recordings")
    return recordings


# ── Step 2: Fetch works (browse API) ────────────────────────────────────────
def fetch_works(mbid):
    print(f"\n[2/3] Fetching works for {ARTIST_NAME} ({mbid})...")
    works  = []
    offset = 0
    limit  = 100

    while True:
        # NOTE: 'artist-rels' is a relationship include, same invalid-for-browse
        # class as 'releases' was on the recording endpoint above (MB browse
        # endpoints only support a narrow whitelist of inc values, not the
        # full lookup-style inc list). Dropped it. ISWCs are core Work
        # attribute data (not a subquery), so they come back with no inc at
        # all — if works_with_iswc shows 0 in the report despite the two
        # known ASCAP ISWCs, that's the signal this assumption was wrong and
        # iswcs needs to be added back as an explicit inc value instead.
        data  = mb_get("work", {"artist": mbid, "limit": limit, "offset": offset})
        batch = data.get("works", [])
        works.extend(batch)
        total = data.get("work-count", len(works))
        print(f"  {len(works)}/{total}...")
        if len(batch) < limit or len(works) >= total:
            break
        offset += limit

    print(f"  Done — {len(works)} works")
    return works


# ── Step 3: Build catalog + cross-reference ──────────────────────────────────
def build_catalog(recordings, works):
    print(f"\n[3/3] Cross-referencing ASCAP data...")

    # Index works by ISWC
    iswc_index = {}
    work_list  = []
    for w in works:
        iswcs = w.get("iswcs", [])
        entry = {
            "mb_work_id": w["id"],
            "title":      w["title"],
            "iswcs":      iswcs,
            "relations":  [
                {"type": r.get("type"), "artist": r.get("artist", {}).get("name")}
                for r in w.get("relations", []) if "artist" in r
            ],
            "ascap_match": False,
        }
        for iswc in iswcs:
            iswc_index[iswc] = entry
        work_list.append(entry)

    # Cross-reference ASCAP known works
    matched = []
    missing = []
    for iswc, title in ASCAP_KNOWN.items():
        if iswc in iswc_index:
            iswc_index[iswc]["ascap_match"] = True
            matched.append({"iswc": iswc, "ascap_title": title, "mb_title": iswc_index[iswc]["title"]})
        else:
            missing.append({"iswc": iswc, "title": title, "note": "NOT IN MUSICBRAINZ — likely unclaimed publisher share"})

    no_iswc = [w for w in work_list if not w["iswcs"]]

    # Normalize recordings
    rec_list = []
    for r in recordings:
        rec_list.append({
            "mb_recording_id": r["id"],
            "title":           r["title"],
            "length_ms":       r.get("length"),
            "isrcs":           r.get("isrcs", []),
            "first_release":   r.get("first-release-date", ""),
            "releases":        [rel.get("title") for rel in r.get("releases", [])[:3]],
        })

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "artist": {"mbid": ARTIST_MBID, "name": ARTIST_NAME, "bmi_ipi": "232427398"},
        "summary": {
            "total_recordings":       len(rec_list),
            "total_works":            len(work_list),
            "works_with_iswc":        len([w for w in work_list if w["iswcs"]]),
            "works_without_iswc":     len(no_iswc),
            "ascap_checked":          len(ASCAP_KNOWN),
            "ascap_matched_in_mb":    len(matched),
            "ascap_missing_from_mb":  len(missing),
        },
        "ascap_cross_reference": {"matched": matched, "missing": missing},
        "works_no_iswc": no_iswc,
        "works":         work_list,
        "recordings":    rec_list,
    }


# ── Report ───────────────────────────────────────────────────────────────────
def write_report(c):
    s = c["summary"]
    lines = [
        "=" * 60,
        "MUSIGOD — ESHAM MUSICBRAINZ CATALOG REPORT",
        f"Generated: {c['generated_at']}",
        "=" * 60,
        "",
        f"Artist: {c['artist']['name']}  MBID: {c['artist']['mbid']}",
        f"BMI IPI (writer): {c['artist']['bmi_ipi']}",
        "",
        "── SUMMARY ──────────────────────────────────────────",
        f"  Recordings:          {s['total_recordings']}",
        f"  Works:               {s['total_works']}",
        f"    with ISWC:         {s['works_with_iswc']}",
        f"    WITHOUT ISWC:      {s['works_without_iswc']}  ← registration gaps",
        "",
        "── ASCAP CROSS-REFERENCE ────────────────────────────",
        f"  Checked:             {s['ascap_checked']}",
        f"  Found in MB:         {s['ascap_matched_in_mb']}",
        f"  Missing from MB:     {s['ascap_missing_from_mb']}  ← publisher share gaps",
        "",
    ]
    for m in c["ascap_cross_reference"]["matched"]:
        lines.append(f"  ✓ {m['iswc']}  {m['ascap_title']}")
    for m in c["ascap_cross_reference"]["missing"]:
        lines.append(f"  ✗ {m['iswc']}  {m['title']}  — {m['note']}")
    lines += [
        "",
        "── WORKS WITHOUT ISWC (top 30) ──────────────────────",
    ]
    for w in c["works_no_iswc"][:30]:
        lines.append(f"  {w['mb_work_id']}  {w['title']}")
    if len(c["works_no_iswc"]) > 30:
        lines.append(f"  ... +{len(c['works_no_iswc'])-30} more in JSON")
    lines += [
        "",
        "── NEXT STEPS ───────────────────────────────────────",
        "  1. Call BMI: 1-800-925-8451 — register MusiGod publisher",
        "     Reference writer IPI: 631016497",
        "  2. ASCAP missing works = priority unclaimed publisher shares",
        "  3. Works without ISWC = register via PRO as publisher",
        "  4. Persist recordings/works to catalog_v1 in Supabase",
        "=" * 60,
    ]
    return "\n".join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    print("MusiGod — Esham MusicBrainz Scraper v2")
    print(f"MBID: {ARTIST_MBID}")
    print("=" * 40)

    recordings = fetch_recordings(ARTIST_MBID)
    works      = fetch_works(ARTIST_MBID)
    catalog    = build_catalog(recordings, works)

    with open("esham_mb_catalog.json", "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    print("\n✓ esham_mb_catalog.json")

    report = write_report(catalog)
    with open("esham_mb_report.txt", "w", encoding="utf-8") as f:
        f.write(report)
    print("✓ esham_mb_report.txt")
    print()
    print(report)


if __name__ == "__main__":
    main()
