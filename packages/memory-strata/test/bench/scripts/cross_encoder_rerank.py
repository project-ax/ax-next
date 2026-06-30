#!/usr/bin/env python3
"""Local cross-encoder reranker for the FAIR-reranker bench config (TASK-192).

Loads a sentence-transformers CrossEncoder ONCE and scores (query, document) pairs.
Communicates over stdin/stdout with newline-delimited JSON requests so the bench's
Node side can spawn one long-lived process and rerank many queries without paying
the model-load cost per query.

Protocol (one JSON object per line on stdin, one per line on stdout):
  request:  {"query": "...", "documents": ["doc text", ...]}
  response: {"scores": [float, ...]}            # aligned to `documents`
  on error: {"error": "message"}

The default model is mixedbread-ai/mxbai-rerank-large-v1 (~435M), the cross-encoder
SmartSearch (arXiv 2603.15599) used. Override with --model. CPU inference is fine for
a bench; it is just slower (the report records the per-query latency this produces).

This is a MEASUREMENT-SPIKE tool, never imported by the shipped runtime. It is not
run in CI (CI stubs the reranker). Install deps in a throwaway venv:

    python3 -m venv /tmp/rerank-venv
    /tmp/rerank-venv/bin/pip install sentence-transformers
"""
import argparse
import json
import sys


def _eprint(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local cross-encoder reranker (stdin/stdout JSON).")
    parser.add_argument("--model", default="mixedbread-ai/mxbai-rerank-large-v1")
    parser.add_argument("--max-length", type=int, default=512)
    args = parser.parse_args()

    try:
        from sentence_transformers import CrossEncoder
    except Exception as exc:  # pragma: no cover - import guard
        _eprint(
            "cross_encoder_rerank.py: could not import sentence_transformers "
            f"({exc!r}). Install it: pip install sentence-transformers"
        )
        return 2

    _eprint(f"cross_encoder_rerank.py: loading model {args.model} (this may download ~1.7GB on first run)…")
    try:
        model = CrossEncoder(args.model, max_length=args.max_length)
    except Exception as exc:
        _eprint(f"cross_encoder_rerank.py: failed to load model {args.model}: {exc!r}")
        return 2
    _eprint("cross_encoder_rerank.py: model loaded, ready.")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            query = req["query"]
            documents = req["documents"]
            if not isinstance(documents, list):
                raise ValueError("documents must be a list")
            if documents:
                pairs = [(query, doc) for doc in documents]
                raw = model.predict(pairs)
                scores = [float(s) for s in raw]
            else:
                scores = []
            sys.stdout.write(json.dumps({"scores": scores}) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            sys.stdout.write(json.dumps({"error": repr(exc)}) + "\n")
            sys.stdout.flush()

    return 0


if __name__ == "__main__":
    sys.exit(main())
