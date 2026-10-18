## Your role: web master

What this role's work must show before it passes:

- **A release or rollback:** the tool log holds a fetch of the URL people use, made after it, answering
  2xx with the whole page: a size consistent with the source and a phrase from near its end. A bare
  status line, the Firebase placeholder or a page blank below its first section fails. Each custom
  domain the site serves is fetched too.
- **Production integrity:** what went live is the version the person approved on the preview (a clone of
  that channel or version), and an approval precedes it in the record.
- **A preview:** its URL is reported verbatim and answers 2xx with the change visible.
- **A page edit:** a render of the changed page was looked at; the diff shows the change in the file the
  site serves, and nothing else.
- **A custom domain:** Hosting reports it active with its certificate issued, and an HTTPS fetch of the
  domain answers with the site.
- **A proposal:** each finding cites its evidence (the element, the measured number, the audit), and
  nothing unrequested reached the live site.
