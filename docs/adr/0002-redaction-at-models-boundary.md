# 2. Redact at the `Models` boundary

Personal data must not reach a model provider. Pi Durable's `beforeRequest` hook can rewrite the messages of a generation request, but the compaction summarizer and code mode call `Models` directly and bypass it, and `afterResponse` can only observe. The one place every request passes through is the `Models` object given to the Harness, so Nudge wraps it: outbound text is replaced with stable placeholders such as `⟦EMAIL1⟧`, and inbound streams are rehydrated before Pi Durable commits them.

The transcript is stored raw on the host. Placeholders are stable per assistant, so the model's view and provider prompt caches stay consistent across turns and rooms.
