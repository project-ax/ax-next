#!/usr/bin/env python3
"""Run inside a throwaway sandbox to check one real provider stream.

A 404 negative probe needs the proxy audit to confirm credentialInjected=false;
HTTP status alone cannot distinguish hidden resources from an invalid key.

Uses only the sandbox's placeholder credential and configured proxy. Never
prints credentials, proxy URLs, response text, or non-inference response data.
This costs one tiny model call; TASK-722 requires the operator's OK first.
"""
import argparse
import json
import os
import subprocess
import sys


def request(provider, method, path, body=None):
    hosts = {"anthropic": "https://api.anthropic.com", "openrouter": "https://openrouter.ai"}
    env_name = "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENROUTER_API_KEY"
    key = os.environ.get(env_name, "")
    if not key.startswith("ax-cred:") or not os.environ.get("HTTPS_PROXY"):
        raise RuntimeError("Run inside a sandbox with a placeholder credential and HTTPS_PROXY.")
    headers = {"content-type": "application/json"}
    if provider == "anthropic":
        headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
        if path.startswith("/v1/files"):
            headers["anthropic-beta"] = "files-api-2025-04-14"
    else:
        headers["authorization"] = "Bearer " + key
    # curl configuration goes over stdin, not argv; nothing secret is logged.
    config = ["url = " + json.dumps(hosts[provider] + path), "request = " + json.dumps(method)]
    config += ["header = " + json.dumps(k + ": " + v) for k, v in headers.items()]
    if body is not None:
        config.append("data = " + json.dumps(json.dumps(body)))
    env = dict(os.environ)
    if not env.get("CURL_CA_BUNDLE") and env.get("NODE_EXTRA_CA_CERTS"):
        env["CURL_CA_BUNDLE"] = env["NODE_EXTRA_CA_CERTS"]
    result = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "90", "--config", "-", "--write-out", "\n%{http_code}"], input="\n".join(config), capture_output=True, text=True, env=env, timeout=100)
    if result.returncode:
        # curl's stderr may contain the proxy URL; report only the numeric code.
        raise RuntimeError("Provider request failed (curl exit %d)." % result.returncode)
    text, status = result.stdout.rsplit("\n", 1)
    return int(status), text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", required=True, choices=["anthropic", "openrouter"])
    parser.add_argument("--non-inference-only", action="store_true")
    parser.add_argument("--model", required=True, help="Exact bare provider model ID, already enabled for the throwaway agent")
    args = parser.parse_args()
    outside = "/v1/files?limit=1" if args.provider == "anthropic" else "/api/v1/auth/key"
    if args.non_inference_only:
        denied, _ = request(args.provider, "GET", outside)
        print(json.dumps({"provider": args.provider, "nonInferenceStatus": denied, "nonInferenceNeedsAuditConfirmation": denied == 404}))
        if denied not in (401, 403, 404):
            raise RuntimeError("Non-inference request did not reject the placeholder (HTTP %d)." % denied)
        return
    body = {"model": args.model, "max_tokens": 16, "stream": True, "messages": [{"role": "user", "content": "Reply with the word OK."}]}
    if args.provider == "openrouter":
        body["stream_options"] = {"include_usage": True}
    inference = "/v1/messages" if args.provider == "anthropic" else "/api/v1/chat/completions"
    status, text = request(args.provider, "POST", inference, body)
    if status != 200:
        raise RuntimeError("Inference failed with HTTP %d." % status)
    counters = {}
    events = 0
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            event = json.loads(line[5:].strip())
        except ValueError:
            continue
        events += 1
        usage = event.get("usage") or event.get("message", {}).get("usage") or {}
        for key, value in usage.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                counters[key] = max(counters.get(key, 0), value)
    if not counters:
        raise RuntimeError("The real stream completed without usage counters.")
    denied, _ = request(args.provider, "GET", outside)
    print(json.dumps({"provider": args.provider, "inferenceStatus": status, "streamEvents": events, "usage": counters, "nonInferenceStatus": denied, "nonInferenceNeedsAuditConfirmation": denied == 404}))
    if denied not in (401, 403, 404):
        raise RuntimeError("Non-inference request did not reject the placeholder (HTTP %d)." % denied)

if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
