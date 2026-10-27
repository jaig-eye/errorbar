#!/usr/bin/env python3
"""A tiny retrieval pipeline that speaks errorbar's command protocol.

Retrieval is BM25 over the text files in docs/. The "answer" is the sentence of the top document
that shares the most words with the question. No model, no dependencies: it is here to show the
protocol, not to be a good RAG system.

The protocol, one JSON object per line:

  stdin   {"id": "...", "case_id": "tracking-1", "vars": {"question": "..."}, "trial": 0}
  stdout  {"id": "...", "output": "...", "contexts": [{"id": "doc-id", "text": "..."}]}

Always echo the request "id". Print only protocol lines on stdout and log to stderr.
"""

import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

DOCS_DIR = Path(__file__).parent / "docs"
TOP_K = int(os.environ.get("RAG_TOP_K", "3"))
# 0 indexes whole documents. A positive number indexes only that many leading characters,
# the kind of chunking change that quietly hurts retrieval.
INDEX_CHARS = int(os.environ.get("RAG_INDEX_CHARS", "0"))

STOPWORDS = set(
    "a an and are as at be by can do does for from how i if in is it long many much my of on or "
    "the to was what when where which who will with you your".split()
)


def stem(word):
    """Strip the commonest English endings so 'days' matches 'day' and 'updates' matches 'update'."""
    for suffix in ("ing", "ed", "es", "s"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def tokens(text):
    words = re.findall(r"[a-z0-9$%-]+", text.lower())
    return [stem(w) for w in words if w not in STOPWORDS]


class Index:
    """Okapi BM25."""

    K1, B = 1.5, 0.75

    def __init__(self, docs):
        self.docs = docs
        self.terms = {doc_id: Counter(tokens(self.indexed(text))) for doc_id, text in docs.items()}
        self.lengths = {doc_id: sum(c.values()) for doc_id, c in self.terms.items()}
        self.avg_length = sum(self.lengths.values()) / len(docs)
        self.df = Counter(term for counts in self.terms.values() for term in counts)

    @staticmethod
    def indexed(text):
        return text[:INDEX_CHARS] if INDEX_CHARS > 0 else text

    def search(self, query):
        n = len(self.docs)
        scored = []
        for doc_id, counts in self.terms.items():
            score = 0.0
            for term in set(tokens(query)):
                if term not in counts:
                    continue
                idf = math.log(1 + (n - self.df[term] + 0.5) / (self.df[term] + 0.5))
                tf = counts[term]
                norm = 1 - self.B + self.B * self.lengths[doc_id] / self.avg_length
                score += idf * tf * (self.K1 + 1) / (tf + self.K1 * norm)
            scored.append((score, doc_id))
        scored.sort(key=lambda pair: (-pair[0], pair[1]))
        return [doc_id for score, doc_id in scored if score > 0]


def best_sentence(question, text):
    wanted = set(tokens(question))
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return max(sentences, key=lambda s: len(wanted & set(tokens(s))))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    docs = {p.stem: p.read_text(encoding="utf-8") for p in sorted(DOCS_DIR.glob("*.txt"))}
    index = Index(docs)
    print(f"loaded {len(docs)} documents", file=sys.stderr)

    for line in sys.stdin:
        request = json.loads(line)
        question = request["vars"]["question"]
        ranked = index.search(question)[:TOP_K]
        output = best_sentence(question, docs[ranked[0]]) if ranked else "I could not find that."
        reply = {
            "id": request["id"],
            "output": output,
            "contexts": [{"id": doc_id, "text": docs[doc_id]} for doc_id in ranked],
        }
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
