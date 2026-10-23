# AnimeIndo adapter (opt-in)

This adapter adds read-only metadata and episode navigation for known public AnimeIndo episode pages.

## Enable locally or on Vercel

AnimeIndo is deliberately not enabled by default. Its current terms and robots.txt have not been independently verified by this project. The shared scraper client requires an explicit robots permission before it fetches any page or JSON endpoint.

Set ANIMEINDO_BASE_URL=https://animeindo.cloud, then append animeindo to your existing SCRAPER_SOURCES value. Important: SCRAPER_SOURCES replaces the default list when set; do not set it to only animeindo unless you intend to disable every other source.

Example (preserve any existing sources you use):

~~~dotenv
ANIMEINDO_BASE_URL=https://animeindo.cloud
SCRAPER_SOURCES=animexin,samehadaku,anoboy,sakunime,anichin,otakudesu,hianime,kuramanime,animeindo
~~~

For Vercel, add the environment variables in Project Settings and redeploy. Never commit secret credentials or cookies.

## Open the episode from Kazanime

The adapter slug format is:

~~~text
animeindo~<series-slug>~<episode-slug>
~~~

For the example supplied during development, a direct watch.html link can be formed as:

~~~text
watch.html?title=Hyouken%20no%20Majutsushi%20ga%20Sekai%20wo%20Suberu%20Season%202&ep=3&slug=animeindo~hyouken-suberu-s2-sub-indo~hnmgsws-s2-episode-3-sub-indo&src=animeindo
~~~

Replace the title and slugs when using another episode. Search/latest discovery is not implemented because no public search/list endpoint was verified yet. The adapter is therefore lookup-only until that structure is observed and tested.

## What it reads

- Public HTML metadata, visible labels, JSON-LD, and episode links on the same AnimeIndo origin.
- The observed same-origin JSON configuration path /api/anime-indo/sources/<episode-slug>, but only if robots policy permits it.
- Explicitly typed HTTPS embed/player page URLs, if present in the JSON response.

It does not call the third-party embed-resolver worker, resolve embeds into direct media file URLs, scrape third-party player pages, solve CAPTCHA/security challenges, or retry around HTTP 403/429 blocks. Direct media URLs and tokens are not written to inspection logs.

## Tests

Run the full project test suite:

~~~bash
npm test
~~~

Parser functions are covered by synthetic HTML/JSON fixtures in server/test/animeindo.test.js; live upstream behavior still needs a local authorized verification.
