# Aurora Forecast Now

Domain: https://auroraforecastnow.com

Aurora Forecast Now is a city-level northern lights forecast site. It turns public space-weather and weather data into plain-English viewing guidance for people asking: "Can I see the aurora tonight?"

## MVP

- NOAA SWPC OVATION aurora forecast grid
- NOAA SWPC Planetary K Index forecast
- Open-Meteo cloud cover forecast
- Pre-generated city pages for SEO
- Static sitemap, robots.txt, ads.txt, About, Contact, and Privacy pages
- 36 city forecast pages at launch

## Architecture

The current version is a static SEO shell with build-time data refresh:

```text
tools/build.mjs
  -> fetch NOAA / Open-Meteo data
  -> score cities
  -> generate forecast JSON
  -> generate homepage and city pages
  -> generate sitemap / robots / ads.txt

Cloudflare Pages
  -> hosts the generated static site
```

This can later evolve into Cloudflare Worker + KV/D1 for higher-frequency refreshes, user alerts, and historical forecast storage.

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

## Data Sources

- NOAA SWPC Aurora 30 Minute Forecast
- NOAA SWPC OVATION Aurora Forecast JSON
- NOAA SWPC Planetary K Index Forecast JSON
- NOAA SWPC Alerts JSON
- Open-Meteo Forecast API
