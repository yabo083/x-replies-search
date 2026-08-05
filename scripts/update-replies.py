#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from twscrape import API, gather
from twscrape.queue_client import XClIdGenStore

PROXY = os.environ.get("TWS_PROXY", "http://127.0.0.1:7890")
DB_PATH = os.environ.get("TWS_DB", "/root/accounts.db")
ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "replies.json"
SOURCES_PATH = ROOT / "data" / "source-posts.json"
CACHE_PATH = Path(os.environ.get("X_REPLY_URL_CACHE", "/root/.cache/x-replies-search-urls.json"))
SHORT_URL_RE = re.compile(r"https://t\.co/[A-Za-z0-9]+")
KNOWN_URL_FIXES = {
    "https://github.com/dothinkerlab/A…": "https://github.com/dothinkerlab/AgentMeter",
    "https://github.com/Mashiro2000/We…": "https://github.com/Mashiro2000/We0Code",
}


class EmptyTransactionId:
    def calc(self, method, path):
        return ""


async def transaction_id(_cls, _username, fresh=False):
    return EmptyTransactionId()


XClIdGenStore.get = classmethod(transaction_id)


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def record(tweet, source_id):
    return {
        "id": str(tweet.id),
        "sourceTweetId": source_id,
        "author": tweet.user.username if tweet.user else "",
        "text": tweet.rawContent or "",
        "createdAt": tweet.createdAt.isoformat() if getattr(tweet, "createdAt", None) else None,
        "likes": getattr(tweet, "likeCount", 0) or 0,
    }


async def resolve_short_urls(records, cache):
    urls = sorted({url for item in records for url in SHORT_URL_RE.findall(item["text"]) if url not in cache})
    if urls:
        import httpx

        semaphore = asyncio.Semaphore(24)
        async with httpx.AsyncClient(proxy=PROXY, follow_redirects=True, timeout=25) as client:
            async def resolve(url):
                async with semaphore:
                    try:
                        response = await client.get(url)
                        target = str(response.url)
                        return url, target if target.startswith("http") else url
                    except Exception:
                        return url, url

            resolved = 0
            for source, target in await asyncio.gather(*(resolve(url) for url in urls)):
                cache[source] = target
                resolved += 1
                if resolved % 100 == 0:
                    print(f"Resolved {resolved} / {len(urls)} new short URLs")

        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")

    for item in records:
        item["text"] = SHORT_URL_RE.sub(lambda match: cache.get(match.group(0), match.group(0)), item["text"])
        for source, target in KNOWN_URL_FIXES.items():
            item["text"] = item["text"].replace(source, target)


async def fetch_thread(api, source_id, limit):
    tweet_id = int(source_id)
    tweets = await gather(api.tweet_thread(tweet_id, limit=limit))
    return [
        tweet for tweet in tweets
        if str(tweet.id) != source_id
        and str(getattr(tweet, "conversationId", "") or "") == source_id
    ]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Reconcile complete visible threads")
    parser.add_argument("--source", help="Only update one source tweet ID")
    args = parser.parse_args()

    configured_sources = read_json(SOURCES_PATH, [])
    if args.source:
        configured_sources = [source for source in configured_sources if source["id"] == args.source]
    if not configured_sources:
        raise RuntimeError("No source posts configured")

    existing = read_json(DATA_PATH, {"replies": [], "sourcePosts": []})
    fallback_source = "2084693319188439211"
    known = {}
    for item in existing.get("replies", []):
        if not item.get("id"):
            continue
        item.setdefault("sourceTweetId", fallback_source)
        known[str(item["id"])] = item
    previous_states = {source["id"]: source for source in existing.get("sourcePosts", [])}

    api = API(pool=DB_PATH)
    await api.pool.login_all()
    cache = read_json(CACHE_PATH, {})
    source_states = []
    changed_records = []
    metadata_changed = False

    for source in configured_sources:
        source_id = source["id"]
        previous = previous_states.get(source_id, {})
        source_metadata_changed = any(previous.get(key) != source.get(key) for key in source)
        metadata_changed = metadata_changed or source_metadata_changed
        source_known = {tweet_id: item for tweet_id, item in known.items() if item.get("sourceTweetId") == source_id}
        root_tweet = await api.tweet_details(int(source_id))
        source_count = getattr(root_tweet, "replyCount", None)
        previous_count = previous.get("sourceReplyCount")
        should_fetch = args.full or not source_known or source_count != previous_count

        if not should_fetch:
            print(f"[{source['key']}] no count change ({source_count}); skip")
            source_states.append({**previous, **source, "sourceReplyCount": source_count, "capturedReplyCount": len(source_known)})
            continue

        delta = max(0, (source_count or len(source_known)) - (previous_count or len(source_known)))
        limit = 2500 if args.full or not source_known else min(1500, max(120, delta * 4 + 60))
        tweets = await fetch_thread(api, source_id, limit)
        fetched = {str(tweet.id): record(tweet, source_id) for tweet in tweets}
        new_ids = fetched.keys() - known.keys()

        if not args.full and source_known and source_count != previous_count and not new_ids:
            print(f"[{source['key']}] count changed but light scan found no new IDs; full fallback")
            tweets = await fetch_thread(api, source_id, 2500)
            fetched = {str(tweet.id): record(tweet, source_id) for tweet in tweets}
            new_ids = fetched.keys() - known.keys()

        new_items = [fetched[tweet_id] for tweet_id in new_ids]
        changed_records.extend(new_items)
        for item in new_items:
            known[item["id"]] = item

        metadata_changed = metadata_changed or source_count != previous_count
        state = {
            **source,
            "sourceReplyCount": source_count,
            "capturedReplyCount": len(source_known) + len(new_items),
            "lastCheckedAt": datetime.now(timezone.utc).isoformat(),
        }
        source_states.append(state)
        print(f"[{source['key']}] +{len(new_items)}, captured {state['capturedReplyCount']}, source count {source_count}")

    if args.source:
        untouched = [state for source_id, state in previous_states.items() if source_id != args.source]
        source_states.extend(untouched)

    await resolve_short_urls(changed_records, cache)

    if not changed_records and not metadata_changed:
        print(f"No changes; snapshot remains {len(known)} replies")
        return

    replies = sorted(known.values(), key=lambda item: (item.get("createdAt") or "", item["id"]))
    source_states.sort(key=lambda source: source.get("publishedAt", ""))
    counts = {source["id"]: 0 for source in source_states}
    for item in replies:
        counts[item["sourceTweetId"]] = counts.get(item["sourceTweetId"], 0) + 1
    for source in source_states:
        source["capturedReplyCount"] = counts.get(source["id"], 0)

    output = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "sourcePosts": source_states,
        "summary": {
            "tweets": len(replies),
            "authors": len({item["author"].lower() for item in replies if item.get("author")}),
            "sourceCount": sum(source.get("sourceReplyCount") or 0 for source in source_states),
            "added": len(changed_records),
            "mode": "full" if args.full else "incremental",
        },
        "replies": replies,
    }
    DATA_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated multi-source snapshot: +{len(changed_records)}, total {len(replies)}")


if __name__ == "__main__":
    asyncio.run(main())
