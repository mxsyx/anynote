## Core Principles

- Keep things simple, concise, clear, and unambiguous.
- Avoid code duplication. Abstract repeated logic to enable code reuse.
- Avoid simply piling up code. Use appropriate abstractions to maintain code maintainability and extensibility.
- When implementing changes, do not make only superficial modifications. Update related logic, tests, and documentation accordingly. When removing something, ask whether related content should also be removed.

## Code Style

- Keep symbol names as concise as possible while preserving semantic clarity within their context.
- Leave at least one blank line between code blocks.
- Leave at least one blank line between comments and the code above them.
- Use the `a.b.c` naming convention for storage keys.

## UI Design

- Use skeuomorphic design.
- Make the UI look like a native application rather than a website.

## Testing

- Add necessary unit tests, integration tests, browser automation tests, and performance tests.

## Comments

- Add detailed comments to code that is difficult to understand.
- Do not add comments for self-explanatory code.
- Use english comments.

## Component Usage

- Reuse existing component libraries whenever possible.

## Performance

- Performance is a top priority for this project. Always use the most efficient implementation that satisfies the functional requirements.
- Always create modal and dialog components dynamically rather than injecting them statically.

## Backward Compatibility

- This project is still under development, so backward compatibility with historical data and legacy logic is not required.
- Do not add tests for removed functionality.
