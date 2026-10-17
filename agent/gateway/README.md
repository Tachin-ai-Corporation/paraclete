# agent/gateway/

The model gateway. It runs one organ turn: builds the request, calls Vertex AI (Gemini, or Claude when
turned on), runs the tool loop, and returns the result with a tool log the model cannot fabricate.

**Belongs here:** the turn loop, provider routing and fallbacks, prompt caching and sessions, the tool
registry and each organ's toolset.
**Doesn't:** deciding what work to do. That is the brain service and `work/`.

The gateway runs as its own service on a local port. Other code calls it over HTTP, never by import.

**Status:** empty. Arrives in build plan phase 3.
