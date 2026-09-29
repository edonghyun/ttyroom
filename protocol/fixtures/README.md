# Cross-language wire fixtures

`wire-v7.json` is a static compatibility baseline for TypeScript and the planned Java backend.

- `messages`: direction is relative to the server; parse `raw` and compare its normalized JSON structure with `expected`. JSON object key order and whitespace are not significant. Cases come from PROTOCOL.md, with explicit normalization defaults and hello examples for both roles.
- `invalidMessages`: must return a bad-message result; validator-specific error wording is not fixed.
- `binary`: decode hex into the expected header fields and opaque payload bytes, and encode the expected frame into exactly the same hex. Integers are unsigned, big-endian; Java must preserve values above signed int maximum.
- `malformedBinary`: must be rejected as malformed. This tests the codec, not connection-close policy.
- Binary vectors were constructed independently with Python struct using the documented layout. They include empty payload, UTF-8 bytes, and uint32 boundaries.

Run `pnpm --filter @ttyroom/protocol test` from the repository root. `src/wire-fixtures.spec.ts` checks all fixtures and coverage of every current message type and room event kind. This is representative contract coverage, not exhaustive field-boundary or authorization coverage; existing unit and E2E tests remain necessary.

Do not regenerate expected data from a new implementation merely to make tests pass. A wire change requires explicit compatibility review and protocol-version policy.
