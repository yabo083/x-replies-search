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

TWEET_ID = 2084693319188439211
TWEET_ID_STR = str(TWEET_ID)
PROXY = os.environ.get("TWS_PROXY", "http://127.0.0.1:7890")
DB_PATH = os.environ.get("TWS_DB", "/root/accounts.db")
ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "replies.json"
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


def record(tweet):
    return {
        "id": str(tweet.id),
        "author": tweet.user.username if tweet.user else "",
        "text": tweet.rawContent or "",
        "createdAt": tweet.createdAt.isoformat() if getattr(tweet, "createdAt", None) else None,
        "likes": getattr(tweet, "likeCount", 0) or 0,
    }


async def resolve_short_urls(records, cache):
    urls = sorted({url for item in records for url in SHORT_URL_RE.findall(item["text"]) if url not in cache})
    if urls:
        import httpx

        semaphore = asyncio.Semaphore(16)
        async with httpx.AsyncClient(proxy=PROXY, follow_redirects=True, timeout=25) as client:
            async def resolve(url):
                async with semaphore:
                    try:
                        response = await client.get(url)
                        target = str(response.url)
                        return url, target if target.startswith("http") else url
                    except Exception:
                        return url, url

            for source, target in await asyncio.gather(*(resolve(url) for url in urls)):
                cache[source] = target

        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")

    for item in records:
        item["text"] = SHORT_URL_RE.sub(lambda match: cache.get(match.group(0), match.group(0)), item["text"])
        for source, target in KNOWN_URL_FIXES.items():
            item["text"] = item["text"].replace(source, target)


async def fetch_thread(api, limit):
    tweets = await gather(api.tweet_thread(TWEET_ID, limit=limit))
    return [
        tweet for tweet in tweets
        if str(tweet.id) != TWEET_ID_STR
        and str(getattr(tweet, "conversationId", "") or "") == TWEET_ID_STR
    ]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Fetch the complete thread for reconciliation")
    args = parser.parse_args()

    existing = read_json(DATA_PATH, {"replies": [], "summary": {}})
    known = {str(item.get("id")): item for item in existing.get("replies", []) if item.get("id")}
    previous_source_count = existing.get("summary", {}).get("sourceReplyCount")

    api = API(pool=DB_PATH)
    await api.pool.login_all()
    root_tweet = await api.tweet_details(TWEET_ID)
    source_count = getattr(root_tweet, "replyCount", None)

    if not args.full and known and previous_source_count == source_count:
        print(f"No reply-count change ({source_count}); skip")
        return

    delta = max(0, (source_count or len(known)) - (previous_source_count or len(known)))
    limit = 1000 if args.full or not known else min(500, max(100, delta * 4 + 40))
    tweets = await fetch_thread(api, limit)
    fetched = {str(tweet.id): record(tweet) for tweet in tweets}
    new_ids = fetched.keys() - known.keys()

    if not args.full and known and source_count != previous_source_count and not new_ids:
        print("Reply count changed but incremental scan found no new IDs; running full reconciliation")
        tweets = await fetch_thread(api, 1000)
        fetched = {str(tweet.id): record(tweet) for tweet in tweets}
        new_ids = fetched.keys() - known.keys()

    changed_records = [fetched[tweet_id] for tweet_id in new_ids]
    cache = read_json(CACHE_PATH, {})
    await resolve_short_urls(changed_records, cache)

    for item in changed_records:
        known[item["id"]] = item

    if not new_ids and known:
        print(f"No new reply IDs; local snapshot remains {len(known)}")
        return

    replies = sorted(known.values(), key=lambda item: (item.get("createdAt") or "", item["id"]))
    output = {
        "tweetId": TWEET_ID_STR,
        "tweetUrl": f"https://x.com/tianyi/status/{TWEET_ID_STR}",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "sources": ["twscrape.tweet_thread(root@bren9np)"],
        "summary": {
            "tweets": len(replies),
            "authors": len({item["author"].lower() for item in replies if item.get("author")}),
            "sourceReplyCount": source_count,
            "added": len(new_ids),
            "mode": "full" if args.full or not existing.get("replies") else "incremental",
        },
        "replies": replies,
    }
    DATA_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated snapshot: +{len(new_ids)}, total {len(replies)}, source count {source_count}")


if __name__ == "__main__":
    asyncio.run(main())
