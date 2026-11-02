#!/usr/bin/env python3
import json
import subprocess
import sys


def headers():
    values = []
    for service in ("actual-mcp-access-id", "actual-mcp-access-secret", "actual-mcp-bearer"):
        result = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-w"],
            capture_output=True, text=True, check=True,
        )
        value = result.stdout.removesuffix("\n")
        if not value or any(ord(char) < 32 or ord(char) > 126 for char in value):
            raise ValueError()
        values.append(value)
    return {
        "CF-Access-Client-Id": values[0],
        "CF-Access-Client-Secret": values[1],
        "Authorization": "Bearer " + values[2],
    }


if __name__ == "__main__":
    try:
        sys.stdout.write(json.dumps(headers()) + "\n")
    except Exception:
        sys.stderr.write("Actual MCP Keychain credentials unavailable\n")
        sys.exit(1)
