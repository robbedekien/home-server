import contextlib
import importlib.util
import io
import json
import os
import tempfile
from pathlib import Path
import subprocess
import runpy
import tomllib
import unittest.mock

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("client_headers", root / "client-headers.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

with unittest.mock.patch.object(helper.subprocess, "run", side_effect=[
    subprocess.CompletedProcess([], 0, "dummy-id\n"),
    subprocess.CompletedProcess([], 0, "dummy-access\n"),
    subprocess.CompletedProcess([], 0, "dummy-bearer\n"),
]) as run:
    result = helper.headers()
    assert result == {"CF-Access-Client-Id": "dummy-id", "CF-Access-Client-Secret": "dummy-access", "Authorization": "Bearer dummy-bearer"}
    assert all(call.args[0][0] == "/usr/bin/security" for call in run.call_args_list)
for value in ("", "\n", "secret\r\ninjected", "secret\0"):
    with unittest.mock.patch.object(helper.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, value)):
        try:
            helper.headers()
            raise AssertionError("invalid header accepted")
        except ValueError:
            pass
with unittest.mock.patch.object(helper.subprocess, "run", side_effect=subprocess.CalledProcessError(1, [], stderr="dummy-secret")):
    try:
        helper.headers()
        raise AssertionError("missing credential accepted")
    except subprocess.CalledProcessError:
        pass

output, errors = io.StringIO(), io.StringIO()
with unittest.mock.patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, [], stderr="dummy-secret")), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
    try:
        runpy.run_path(str(root / "client-headers.py"), run_name="__main__")
        raise AssertionError("helper succeeded without credentials")
    except SystemExit as error:
        assert error.code == 1
assert output.getvalue() == "" and "dummy-secret" not in errors.getvalue()
codex = tomllib.loads((root / "codex.example.toml").read_text())["mcp_servers"]["actual"]
claude = json.loads((root / "claude.example.json").read_text())["mcpServers"]["actual"]
assert claude["type"] == "http" and claude["url"] == "https://actual-mcp.robbedekien.be/mcp"
assert "client-headers.py" in claude["headersHelper"]
assert codex["url"] == claude["url"]
assert codex["http_headers_helper"] == claude["headersHelper"]
print("PASS: shared Keychain headers, missing/invalid credentials, no leaked failure output, Codex TOML + Claude JSON")

with tempfile.TemporaryDirectory(prefix="finance-codex-config-") as temp:
    Path(temp, "config.toml").write_text((root / "codex.example.toml").read_text())
    check = subprocess.run(["codex", "mcp", "get", "actual", "--json"], env={**os.environ, "CODEX_HOME": temp}, capture_output=True, text=True)
    assert check.returncode == 0, "Codex native config parsing failed"
    parsed = json.loads(check.stdout)["transport"]
    assert parsed["url"] == codex["url"] and parsed["http_headers_helper"] is not None
with tempfile.TemporaryDirectory(prefix="finance-claude-config-") as temp:
    check = subprocess.run(["claude", "mcp", "add-json", "actual", json.dumps(claude), "--scope", "user"], env={**os.environ, "CLAUDE_CONFIG_DIR": temp}, capture_output=True, text=True)
    assert check.returncode == 0, "Claude native config parsing failed"
    parsed = json.loads(Path(temp, ".claude.json").read_text())
    assert parsed["mcpServers"]["actual"] == claude
print("PASS: installed Codex and Claude native header-helper config parsing in temporary directories")
