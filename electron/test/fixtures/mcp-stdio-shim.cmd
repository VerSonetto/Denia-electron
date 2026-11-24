@echo off
REM Windows .cmd shim wrapping the stdio MCP fixture, used to verify that
REM Denia routes shim commands through cmd.exe instead of spawning them
REM directly (which fails with `spawn EINVAL`). %* forwards every argument.
node "%~dp0mcp-stdio-server.mjs" %*
