---
"capnweb": minor
---

Add AsyncGenerator-over-RPC support with a native client AsyncGenerator object. Async generators
now support in-place `consume(options)` tuning for buffered prefetch to reduce roundtrips while
keeping strict one-step advancement as the default behavior.
