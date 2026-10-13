# Dexterity from Supervised Play: project page

Static site for the DSP paper. Plain HTML, CSS and JavaScript with no build step, so it can be served
as-is from GitHub Pages or any static host.

## Run it locally

The world-model scrubber seeks video frame by frame, which needs a server with HTTP range support.
`python3 -m http.server` does not support ranges (the scrubber then falls back to plain looping
playback). Either of these works:

```bash
npx http-server -p 8000 .
# or any other static server with range requests, then open http://localhost:8000
```

## Layout

```
index.html                 the page
static/css/style.css       page styles (design tokens at the top)
static/css/planner-toy.css styles for the in-browser planning toy
static/js/main.js          page behavior: lazy autoplay, lightbox, chart videos, pipeline
                           scrollytelling, world-model scrubber, MPC stepper, toggles, BibTeX copy
                           (the eight hardware runs are plain autoplay clips)
static/js/planner-toy.js   the in-browser planning toy (mounted on <div data-planner-toy>)
static/videos/             web encodes of the clips from the slide deck
static/posters/            poster frames (and thumbs/ for the gallery)
static/charts/             result charts rendered as short videos, plus chart metadata
static/images/             pipeline figure, setup photo, Push-T planning panels, favicon, og image
static/media.json          per-clip metadata (size, duration, start and end angle for hardware runs)
scripts/media/, scripts/charts/   how the videos and chart videos were produced
```

## Before going public

- The hero says "Paper, arXiv and code are coming soon." The link-button markup is kept in a
  commented-out block next to it; restore it with the real URLs (search `TODO` in `index.html`).
- Author affiliations are listed without per-author superscripts until the mapping is confirmed.
- The distillation speed-up is phrased as "several times faster than a full MPC replan" because the
  paper's "7x" does not match 133.6 ms / 21.8 ms (about 6x); confirm which replan the 7x refers to.
- `og:image` and `og:url` are relative until the domain is known.
- The BibTeX entry is a `@misc` placeholder; switch it to the arXiv entry once there is an ID.
- `static/images/og.jpg` is used for link previews; replace it if a designed teaser exists.
