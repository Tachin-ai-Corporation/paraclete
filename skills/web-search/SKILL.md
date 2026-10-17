# Skill: Web Search and Fetch

## When to use

When a task needs current information from the web, or the text of a specific web page. Both commands
only read; they change nothing.

## Commands

- `web-search "<question>"` asks Gemini with Google Search grounding. Prints the answer, then
  `Sources:` (a numbered list of titles and links the answer was grounded in) and `Searches:` (the
  queries that ran). When no sources come back, it says so: treat that answer as unverified.
- `web-search --stdin` reads the question from stdin. Use it, with the runCommand tool's `stdin` field,
  whenever the question holds quotes, apostrophes or newlines.
- `web-fetch --url "<url>" [--format text|html] [--max <bytes>] [--timeout <seconds>]` fetches one
  page (http or https). `text`, the default, prints `TITLE:`, `DESCRIPTION:` and `IMAGES:` lines when
  the page has them, then the readable text with scripts, styles, navigation and footers removed;
  `html` prints the raw markup. `--max` caps how much is read (default 500000 bytes) and `--timeout`
  how long to wait (default 10 seconds). A page longer than the cap is cut, with a note saying so. A
  redirect prints the final `URL:` first.

A document rather than a web page (a PDF, an office file, an image, an archive) is refused by
`web-fetch` with the route to take: fetch it with the files skill and read it from there.

## Procedures

### Research a current topic

1. Pose a specific question.
2. `web-search "<question>"`.
3. Check that the answer lists sources. For a load-bearing claim, fetch the source page and read it:
   a search answer is a summary of sources, so a claim you only saw there is "reported, unverified"
   until you read the page.

### Read a page

1. Find the URL with `web-search`, or start from a known one.
2. `web-fetch --url "<url>"`.
3. Check that the output is the page's content, not a navigation shell, a login page or an error page.
   A page that builds its content with JavaScript may come back nearly empty; say so rather than
   guessing at what it contains.

## Error recovery

| Symptom | Cause | What to do |
|---|---|---|
| `HTTP 403` or `HTTP 429` from `web-fetch` | The site refuses automated readers, or rate-limits | Try another source for the same fact; don't retry in a loop |
| `HTTP 404` | The page moved or never existed | Search again for the current location |
| `the request failed` or a timeout | The site is slow or down | Retry once with `--timeout 30`, then use another source |
| `Vertex AI returned HTTP ...` from `web-search` | The model service refused or failed | Retry once; if it persists, report the error |
| `Sources: none returned` | The answer was not grounded in a search | Rephrase the question more specifically, or fetch known sources directly |
