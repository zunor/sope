# Workspace conventions

- All repository-authored content must be in English, including internal and
  model-facing prompts, tool descriptions, UI text, errors, logs, comments,
  documentation, scripts, and test fixtures. Do not introduce Chinese text or
  hide it in escaped strings. Use English text for new content and translate
  existing non-English prose when editing it.
- Preserve Unicode support and regression coverage: use fullwidth Latin letters,
  combining marks, and emoji for general Unicode fixtures, and explicit numeric
  code points for tests of specific Unicode ranges. This language rule applies
  to repository-authored content, not to user input or external data at runtime.
- After completing the user's authorized changes and passing the necessary
  validation, automatically create a local Git commit without asking for another
  confirmation. Stage only files belonging to the task; preserve unrelated work.
- Automatic local commits do not authorize pushing, publishing or deployment.
