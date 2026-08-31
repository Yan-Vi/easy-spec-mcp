# easy-spec-mcp

MCP server for Easy Spec - Playwright projects. It lets an MCP-connected assistant (Claude Code, Claude Desktop, etc.) read and edit flows, scenarios, page objects, and variables, and drive live browser automation -- all by relaying every operation to the companion browser extension's side panel.

This server never reads project files or drives a browser itself. It holds no filesystem adapter and spawns no browser process; every tool call is forwarded over a local WebSocket bridge to an already-connected, human-approved side panel, which performs the action and reports back.

## Requirements

- Node.js 18+
- The Easy Spec - Playwright browser extension installed, with its side panel open and connected to your project folder
- The MCP agent must be approved in the side panel before any `live_*` tool will work

## Install / run

No install needed -- run it with `npx`:

```
npx easy-spec-mcp
```

### Add to an MCP client

```json
{
  "mcpServers": {
    "easy-spec": {
      "command": "npx",
      "args": ["easy-spec-mcp"],
      "env": {
        "EASYSPEC_PROJECT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

`EASYSPEC_PROJECT` is optional -- every tool also accepts a `project` argument. If omitted, tools fall back to `EASYSPEC_PROJECT`, and the `live_*` tools can auto-target the single connected side panel with neither.

## Tools

- **Inspection** -- `list_flows`, `list_scenarios`, `list_page_objects`, `get_variables`, `get_flow`, `get_scenario`, `get_page_object`
- **Flow authoring** -- `create_flow`, `delete_flow`, `set_flow_meta`, `add_step`, `add_multiple_steps`, `update_step`, `remove_step`, `copy_steps`, `set_flow_dataset`, `remove_flow_dataset`, `set_state_var`, `remove_state_var`, `set_output_field`, `remove_output_field`
- **Page objects** -- `create_page_object`, `delete_page_object`, `set_locator`, `remove_locator`
- **Scenarios** -- `create_scenario`, `delete_scenario`, `add_flow_to_scenario`, `remove_flow_from_scenario`, `set_scenario_dataset`, `remove_scenario_dataset`
- **Variables** -- `set_variable`, `unset_variable`
- **Live browser control** (requires a connected, approved side panel) -- `live_status`, `live_replay_flow`, `live_replay_scenario`, `live_run_step`, `live_run_multiple_steps`, `live_run_step_range`, `live_pick_element`, `live_snapshot`, `live_screenshot`, `live_detach`
- **Run tracking** -- `live_start_run`, `live_list_runs`, `live_get_run`, `live_cancel_run`, `live_start_scenario_run`, `live_list_scenario_runs`, `live_get_scenario_run`, `live_cancel_scenario_run`
- **Tab management** -- `live_list_tabs`, `live_switch_tab`, `live_new_tab`

Call `live_status` first to see which projects have a connected side panel and what to pass as `project`/`session`.

## License

MIT
