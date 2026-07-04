# Aurora Forecast Now

Domain: https://auroraforecastnow.com

Aurora Forecast Now is a city-level northern lights forecast site. It turns public space-weather and weather data into plain-English viewing guidance for people asking: "Can I see the aurora tonight?"

## MVP

- NOAA SWPC OVATION aurora forecast grid
- NOAA SWPC Planetary K Index forecast
- Open-Meteo cloud cover forecast
- Pre-generated city pages for SEO
- Country, state/region, guide, and glossary collection pages
- WebSite, CollectionPage, ItemList, FAQPage, Article, and Breadcrumb structured data
- Live city lookup for arbitrary city names via Open-Meteo geocoding
- Latitude/longitude forecast lookup for custom locations
- Static sitemap, robots.txt, ads.txt, About, Contact, and Privacy pages
- 164 saved city forecast pages at launch, with live lookup for cities outside the saved list

## Architecture

The current version is a static SEO shell with build-time data refresh:

```text
tools/build.mjs
  -> fetch NOAA / Open-Meteo data
  -> score cities
  -> generate forecast JSON
  -> generate homepage, city pages, location collections, guides, and glossary
  -> generate sitemap / robots / ads.txt

Cloudflare Pages
  -> hosts the generated static site
```

The live forecast layer now runs on Cloudflare Worker + KV:

```text
auroraforecastnow.com/api/forecast
  -> read latest forecast from KV
  -> resolve city names through preset cities or Open-Meteo geocoding
  -> score arbitrary coordinates against the latest NOAA aurora grid
  -> return stale data when expired
  -> refresh in the background

auroraforecastnow.com/api/forecast?city=Tokyo
auroraforecastnow.com/api/forecast?q=Oslo
auroraforecastnow.com/api/forecast?lat=40.7128&lon=-74.0060
  -> live city / coordinate lookup
  -> geocoding results cached in KV for 30 days

Cron trigger: */5 * * * *
  -> normal mode: full refresh every 30 minutes
  -> storm mode: full refresh every 5 minutes when NOAA alerts include G2+
```

The generated city pages are SEO entry pages, not the product limit. The saved city pool is curated in `data/city-seeds.json`, resolved into `data/cities.json`, and sorted dynamically by live forecast score at build/runtime. The live API can also score any resolved city or valid latitude/longitude. D1 is still reserved for later user-facing features such as email alerts, favorites, observations, and historical forecast analytics.

## SEO Page Matrix

- `/locations/`: full city index and collection hub
- `/countries/<country>/`: country-level city collections
- `/states/<region-country>/`: state, province, and region city collections
- `/guides/`: evergreen aurora forecast guide index
- `/guides/how-to-read-aurora-forecast/`
- `/guides/kp-index-aurora-forecast/`
- `/guides/cloud-cover-aurora-viewing/`
- `/guides/aurora-oval-map/`
- `/glossary/`: plain-English forecast terms
- `sitemap.xml`: generated from the current city, country, region, guide, and utility page matrix

Build:

```bash
node tools/build.mjs
python3 -m http.server 4176
```

Deploy draft:

```bash
node tools/build.mjs
rm -rf .deploy
mkdir -p .deploy
rsync -a --exclude '.deploy' --exclude 'tools' --exclude 'site.config.json' --exclude '*.md' ./ .deploy/
npx wrangler pages deploy .deploy --project-name aurora-forecast-now --branch main
```

Deploy Worker:

```bash
npx wrangler deploy --config wrangler.worker.toml
```

## Data Sources

- NOAA SWPC Aurora 30 Minute Forecast
- NOAA SWPC OVATION Aurora Forecast JSON
- NOAA SWPC Planetary K Index Forecast JSON
- NOAA SWPC Alerts JSON
- Open-Meteo Forecast API

## Live API

```bash
curl https://auroraforecastnow.com/api/health
curl https://auroraforecastnow.com/api/forecast
curl 'https://auroraforecastnow.com/api/forecast?city=fairbanks'
curl 'https://auroraforecastnow.com/api/forecast?city=Tokyo'
curl 'https://auroraforecastnow.com/api/forecast?q=Oslo'
curl 'https://auroraforecastnow.com/api/forecast?lat=40.7128&lon=-74.0060'
```

## Development

```bash
# 重新生成全站静态页（拉 NOAA 实时数据；加 AURORA_USE_EXISTING_FORECAST=1 用缓存数据做 deterministic build）
node tools/build.mjs

# 评分核心（lib/forecast-core.mjs，build 与 worker 共用）的行为锁定测试
node --test tests/forecast-core.test.mjs

# 部署（🚨 只用这个脚本，排除清单是安全边界，别用裸 wrangler 命令）
sh deploy.sh pages    # 静态站
sh deploy.sh worker   # API worker
sh deploy.sh all      # 两者

# 查 Cloudflare 流量（不走浏览器；token 见 ~/.cloudflare/api_token）
python3 ~/sekai.app.dir/tools/cf_api.py daily auroraforecastnow.com
```
