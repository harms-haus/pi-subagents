# Settings

pi-subagents reads configuration from JSON settings files. Unlike profile files, settings control runtime behavior such as display dimensions and truncation limits.

## Settings File Locations

Settings are loaded from two locations. Project-local settings override global settings for the same key.

| Location | Path                               |
| -------- | ---------------------------------- |
| Global   | `~/.pi/agent/settings.json`        |
| Project  | `<project-root>/.pi/settings.json` |

The global location can be overridden by setting the `PI_AGENT_DIR` environment variable.

Both files are optional. If neither exists, defaults are used.

## Settings Reference

All pi-subagents settings live under the `"subagents"` key in the settings JSON.

| Setting                             | Type     | Default                                     | Description                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents.maxLinesPerWindow`       | `number` | `15`                                        | Number of lines displayed in each sub-agent's rolling TUI window. Also controls how much output is shown by `get_subagent_output` and `get_subagent_session`.                                                                                                                                        |
| `subagents.commandPreviewWidth`     | `number` | Terminal width − 4 (TTY) or `160` (non-TTY) | Maximum character width for tool call preview rendering. Clamped to a minimum of `20`.                                                                                                                                                                                                               |
| `subagents.extend_timeout_debounce` | `number` | `30`                                        | When a sub-agent is actively working (making tool calls) when its timeout expires, the timeout is extended by this many seconds. Each new tool call resets the extension timer. The original timeout value is still displayed in the TUI. Clamped to 0–300. Set to `0` to disable timeout extension. |
| `subagents.looping_tool_count`      | `number` | `5`                                         | Number of consecutive identical tool calls required to trigger loop detection. When this many consecutive tool call signatures (serialized as JSON) are identical strings, the sub-agent is immediately killed with an error. Set to `0` to disable loop detection. Clamped to 0–50.                     |

### `commandPreviewWidth` Resolution Logic

This setting has a two-tier resolution:

1. **TTY detected** (`process.stdout.columns` is available): Uses the terminal's column count minus 4 (accounting for a 2-character indent and the `→ ` prefix), clamped to a minimum of 20. Settings files are **not** consulted in this case.
2. **Non-TTY** (piped output, CI, etc.): Falls back to settings files (project overrides global), defaulting to `160` if no setting is found, clamped to a minimum of 20.

## Example

```json
{
  "subagents": {
    "maxLinesPerWindow": 25,
    "commandPreviewWidth": 120,
    "extend_timeout_debounce": 30,
    "looping_tool_count": 5
  }
}
```

## Related Configuration

- **Profiles** — Named agent profiles (model, tools, system prompt) are defined in separate markdown files. See [docs/profiles.md](profiles.md).
- **Architecture** — For how settings and profiles fit into the broader system, see [docs/architecture.md](architecture.md).
