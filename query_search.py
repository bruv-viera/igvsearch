"""
Interactive hybrid search engine over IGV document profiles.

Sparse side : BM25 (rank_bm25)
Dense side  : BAAI/bge-small-en-v1.5 sentence embeddings, cosine similarity
Fusion      : Reciprocal Rank Fusion (RRF), k = 60, equal weights

USAGE
-----
    pip install pandas rank-bm25 sentence-transformers
    python search_engine.py            (expects profiles.csv in the same folder)
    python search_engine.py path\\to\\profiles.csv

Type a query at the prompt. Type  exit  to quit.
Every search prints 5 tables; the final hybrid table is also appended
to hybrid_results.csv.
"""


"TO RUN"
"pip install pandas rank-bm25 sentence-transformers"
"python search_engine.py    profiles_out\profiles.csv"

import os
import re
import sys
import hashlib
from pathlib import Path

import numpy as np
import pandas as pd
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer

K_RRF      = 60      # RRF constant
TOP_RANKER = 10      # rows shown for sparse and dense tables
TOP_FINAL  = 20      # rows shown/saved for the final hybrid table


EMBED_CACHE = "doc_vecs_cache.npz"

# BGE models work best when the query (not the documents) gets this prefix:
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

STOPWORDS = set("""a an and are as at be by for from has have in is it its of on or
that the this to was were will with your you we our their they not no all any can
map maps interactive view data www http https com org net nan""".split())


def tokenize(text):
    """lowercase, keep alphanumeric words, drop stopwords"""
    words = re.findall(r"[a-z0-9]+", str(text).lower())
    return [w for w in words if w not in STOPWORDS]


def build_doc_text(row):
    """Concatenate the searchable profile fields into one string."""
    fields = [
        "title", "meta_description", "extended_description",
        "topic_terms", "place_terms", "related_topic_terms",
        "related_place_terms", "years", "time_interval"
    ]

    parts = []

    for f in fields:
        v = row.get(f)
        if pd.notna(v) and str(v).strip() and str(v) != "nan":
            parts.append(str(v).replace(";", " "))

    return " ".join(parts)


def show(df, title):
    """Print a table with a heading."""
    print(f"\n--- {title} ---")
    print(df.to_string(index=False))


def clear_terminal():
    """Clear the terminal screen."""
    os.system("cls" if os.name == "nt" else "clear")


def safe_filename_from_query(query, max_len=80):
    """
    Convert the user's query into a safe CSV filename.
    Example: 'population density maps?' -> 'population_density_maps.csv'
    """
    filename = query.lower().strip()
    filename = re.sub(r"[^a-z0-9]+", "_", filename)
    filename = filename.strip("_")
    filename = filename[:max_len]

    if not filename:
        filename = "empty_query"

    return filename + ".csv"

def corpus_fingerprint(df):
    """
    Create a stable fingerprint for the current searchable corpus.
    If doc_text or igv_id changes, cached embeddings are invalidated.
    """
    h = hashlib.sha256()

    for igv_id, text in zip(df["igv_id"].astype(str), df["doc_text"].astype(str)):
        h.update(igv_id.encode("utf-8"))
        h.update(b"\0")
        h.update(text.encode("utf-8"))
        h.update(b"\n")

    return h.hexdigest()


def encode_or_load_doc_vecs(model, df, cache_path=EMBED_CACHE):
    """
    Load document embeddings from cache if they match the current corpus.
    Otherwise encode documents and save a fresh cache.
    """
    cache_path = Path(cache_path)
    fingerprint = corpus_fingerprint(df)

    if cache_path.exists():
        try:
            cache = np.load(cache_path, allow_pickle=False)

            if cache["fingerprint"].item() == fingerprint:
                print(f"Loading cached document embeddings from {cache_path} ...")
                return cache["doc_vecs"]

        except Exception:
            print("Embedding cache could not be read. Recomputing embeddings ...")

    print("Encoding documents ...")
    doc_vecs = model.encode(
        df["doc_text"].tolist(),
        normalize_embeddings=True,
        show_progress_bar=True,
        convert_to_numpy=True,
    )

    np.savez_compressed(
        cache_path,
        doc_vecs=doc_vecs,
        fingerprint=fingerprint,
    )

    return doc_vecs


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "profiles.csv"

    # ---------- startup: load + filter ----------
    print(f"Loading {csv_path} ...")
    df = pd.read_csv(csv_path)
    df = df[df["status_flag"] == "usable"].reset_index(drop=True)
    print(f"Usable records: {len(df)}")

    # ---------- build document text ----------
    df["doc_text"] = df.apply(build_doc_text, axis=1)

    # ---------- sparse index (BM25) ----------
    print("Building BM25 index ...")
    bm25 = BM25Okapi([tokenize(t) for t in df["doc_text"]])

        # ---------- dense index (BGE embeddings) ----------
    print("Loading embedding model (first run downloads ~130 MB) ...")
    model = SentenceTransformer("BAAI/bge-small-en-v1.5")
    doc_vecs = encode_or_load_doc_vecs(model, df)
    
    # short display title
    df["short_title"] = df["title"].fillna("(no title)").astype(str).str.slice(0, 55)

    print("\nReady. Type a query, reset or 'exit' to quit.\n")
    qnum = 0

    while True:
        query = input("query> ").strip()
        if not query:
            continue
        if query.lower() in ("exit", "quit", "q"):
            print("Bye.")
            break
        if query.lower() == "reset":
            clear_terminal()
            print("Terminal cleared. Type a query, or 'exit' to quit.\n")
            continue

        qnum += 1
        qid = f"Q{qnum:02d}"

        out_csv = safe_filename_from_query(query)

                
# ---------- sparse retrieval ----------
        sparse_scores = bm25.get_scores(tokenize(query))

        # Tie-aware rank: tied scores receive the same rank
        sparse_rank = (
            pd.Series(sparse_scores)
            .rank(method="min", ascending=False)
            .astype(int)
            .to_numpy()
        )

        # For RRF, documents with BM25 score 0 should get no sparse credit
        sparse_rank_for_rrf = sparse_rank.astype(float)
        sparse_rank_for_rrf[sparse_scores <= 0] = np.inf

        sparse_tbl = pd.DataFrame({
            "query_id": qid,
            "igv_id": df["igv_id"],
            "title": df["short_title"],
            "url": df["url"],
            "sparse_score": sparse_scores.round(2),
            "sparse_rank": sparse_rank,
        })

        # Only display actual lexical matches
        sparse_tbl = (
            sparse_tbl[sparse_tbl["sparse_score"] > 0]
            .sort_values("sparse_rank")
            .head(TOP_RANKER)
        )

        show(sparse_tbl, f"{qid}  SPARSE RETRIEVAL (BM25 nonzero matches)  top {TOP_RANKER}")


# ---------- dense retrieval ----------
        qvec = model.encode(BGE_QUERY_PREFIX + query, normalize_embeddings=True)
        dense_scores = doc_vecs @ qvec
        dense_rank = (
           pd.Series(dense_scores)
           .rank(method="min", ascending=False)
           .astype(int)
           .to_numpy()
        )

        dense_tbl = pd.DataFrame({
            "query_id": qid,
            "igv_id": df["igv_id"],
            "title": df["short_title"],
            "url": df["url"],
            "dense_score": dense_scores.round(3),
            "dense_rank": dense_rank,
        }).sort_values("dense_rank").head(TOP_RANKER)
        show(dense_tbl, f"{qid}  DENSE RETRIEVAL (BGE cosine)  top {TOP_RANKER}")

# ---------- combined ranks ----------
        combined = pd.DataFrame({
            "query_id": qid,
            "igv_id": df["igv_id"],
            "title": df["short_title"],
            "url": df["url"],
            "sparse_rank": sparse_rank,
            "dense_rank": dense_rank,
            "sparse_rank_for_rrf": sparse_rank_for_rrf,
        })

        combined["best"] = combined[["sparse_rank_for_rrf", "dense_rank"]].min(axis=1)

        in_top = combined[
            (combined["sparse_rank_for_rrf"] <= TOP_RANKER) |
            (combined["dense_rank"] <= TOP_RANKER)
        ]

        show(
            in_top.sort_values("best").drop(columns=["best", "sparse_rank_for_rrf"]),
            f"{qid}  COMBINED RANKS (union of both top {TOP_RANKER})"
        )

# ---------- RRF ----------
        combined["rrf_score"] = (
            1 / (K_RRF + combined["sparse_rank_for_rrf"])
            + 1 / (K_RRF + combined["dense_rank"])
        )

        combined["rrf_calculation"] = np.where(
            np.isinf(combined["sparse_rank_for_rrf"]),
            "0 + 1/(" + str(K_RRF) + "+" + combined["dense_rank"].astype(str) + ")",
            "1/(" + str(K_RRF) + "+" + combined["sparse_rank"].astype(str) + ") + 1/("
            + str(K_RRF) + "+" + combined["dense_rank"].astype(str) + ")"
        )

        combined = combined.sort_values("rrf_score", ascending=False)
        combined["hybrid_rank"] = range(1, len(combined) + 1)

        rrf_calc = combined.head(TOP_FINAL)[
            ["query_id", "igv_id", "title", "url",
             "sparse_rank", "dense_rank", "rrf_calculation", "rrf_score"]].copy()
        rrf_calc["rrf_score"] = rrf_calc["rrf_score"].round(4)
        show(rrf_calc, f"{qid}  RRF CALCULATION  top {TOP_FINAL}")

        final = combined.head(TOP_FINAL)[
            ["query_id", "igv_id", "title", "url",
             "sparse_rank", "dense_rank", "rrf_score", "hybrid_rank"]].copy()
        final["rrf_score"] = final["rrf_score"].round(4)
        show(final, f"{qid}  FINAL HYBRID RESULT  top {TOP_FINAL}")

# save final table to a CSV named after the query
        final.to_csv(out_csv, index=False, encoding="utf-8-sig")
        print(f"\n[saved to {out_csv}]\n")


if __name__ == "__main__":
    main()
