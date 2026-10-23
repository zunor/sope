# Documentation

[Back to sope](../README.md)

sope has two entry points: a terminal workspace for using agents, and a C library for embedding them. Start with the path that fits your work.

## Use the terminal

| Guide | What you will find |
|---|---|
| [Getting started](guide/quickstart.md) | Installation, model setup, and your first conversation |
| [Terminal workspace](guide/terminal.md) | Sessions, images, tool previews, permissions, keys, and commands |
| [Configuration](guide/configuration.md) | Environment variables, CLI flags, and defaults |
| [English demos](guide/demos.md) | Three reproducible scenarios with a scripted local model |

## Embed and develop

| Reference | What you will find |
|---|---|
| [C ABI](abi.md) | Threading, lifetimes, events, tools, subagents, and providers |
| [Development](development.md) | Build commands, validation, and the source layout |
| [Releases and versioning](release.md) | ABI compatibility, packaging, and release steps |
| [Changelog](../CHANGELOG.md) | Changes by release |

The public contract lives in `include/sope.h`. The library, bindings, and executable share one version number.
