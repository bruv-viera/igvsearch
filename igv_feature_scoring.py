"""
IGV hybrid retrieval and feature scoring pipeline.

Inputs
------
1. profiles CSV, e.g. profiles(1).csv
2. structured query CSV with these columns:
   query_id, query_text, topic_text, topic_terms, places, start_year, end_year

Method
------
1. Filter profiles to status_flag == "usable".
2. Rank every profile for each query using:
   - BM25
   - dense BGE similarity
   - equal-weight Reciprocal Rank Fusion (RRF), k=60
3. Keep the top 10 baseline results per query.
4. Calculate:
   ThEM, ThSM, GeoEM, GeoRM, TempEM, TempCM, TGI, TGTI
5. Save one CSV per query and one combined CSV.


pip install pandas numpy rank-bm25 sentence-transformers
python build_selection.py --profiles profiles.csv --queries queries_structured_v2.csv --pool 40

python make_items.py --profiles profiles.csv --selection selection.csv

Source credibility is deliberately excluded.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import re
import unicodedata
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer


MODEL_NAME = "BAAI/bge-small-en-v1.5"
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
RRF_K = 60
TOP_K = 10
RELATED_PLACE_SCORE = 0.75
BROADER_PLACE_SCORE = 0.50

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
    "has", "have", "in", "is", "it", "its", "of", "on", "or", "that",
    "the", "this", "to", "was", "were", "will", "with", "map", "maps",
    "interactive", "dashboard", "dashboards", "view", "data", "nan",
}

LIVE_WORDS = {
    "live", "real time", "real-time", "realtime", "near real time",
    "near-real-time", "current conditions", "updated continuously",
    "continuously updated", "latest alerts",
}

PLACE_ALIASES = {
    "u s": "united states",
    "us": "united states",
    "u s a": "united states",
    "usa": "united states",
    "united states of america": "united states",
    "united states": "united states",
    "north american": "north america",
    "north america": "north america",
    "world": "global",
    "worldwide": "global",
    "global": "global",
}

NORTH_AMERICA_MEMBERS = {
    "united states", "canada", "mexico", "greenland", "bermuda",
    "saint pierre and miquelon",
}


# ---------------------------------------------------------------------------
# Basic cleaning and parsing
# ---------------------------------------------------------------------------

def text_value(value: object) -> str:
    """Return a clean string, treating missing values as empty."""
    if value is None or pd.isna(value):
        return ""
    value = str(value).strip()
    return "" if value.lower() == "nan" else value


def normalise_text(value: object) -> str:
    """Lowercase text, remove accents and normalise punctuation/spacing."""
    text = text_value(value).lower()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def split_terms(value: object) -> set[str]:
    """Parse semicolon-separated terms into a normalised set."""
    text = text_value(value)
    if not text:
        return set()
    return {
        normalise_text(part)
        for part in text.split(";")
        if normalise_text(part)
    }


def canonical_place(value: object) -> str:
    """Normalise a place name and apply the aliases needed by the queries."""
    place = normalise_text(value)
    return PLACE_ALIASES.get(place, place)


def split_places(value: object) -> set[str]:
    """Parse semicolon-separated places into canonical names."""
    text = text_value(value)
    if not text:
        return set()
    return {
        canonical_place(part)
        for part in text.split(";")
        if canonical_place(part)
    }


def parse_years(value: object) -> set[int]:
    """Extract plausible four-digit years from a CSV field."""
    years = {
        int(year)
        for year in re.findall(r"\b(?:1[0-9]{3}|20[0-9]{2}|2100)\b", text_value(value))
    }
    return years


def number_or_none(value: object) -> int | None:
    """Convert a CSV year value to int or return None."""
    if value is None or pd.isna(value) or text_value(value) == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def parse_interval(time_interval: object, years_value: object) -> tuple[int, int] | None:
    """Read a document interval, falling back to min/max values in years."""
    interval_years = sorted(parse_years(time_interval))
    if len(interval_years) >= 2:
        return interval_years[0], interval_years[-1]
    if len(interval_years) == 1:
        return interval_years[0], interval_years[0]

    years = sorted(parse_years(years_value))
    if years:
        return years[0], years[-1]
    return None


def tokenize(value: object) -> list[str]:
    """Simple BM25 tokenisation."""
    return [word for word in normalise_text(value).split() if word not in STOPWORDS]


def contains_live_language(value: object) -> bool:
    """Check whether text explicitly signals live or real-time information."""
    text = normalise_text(value)
    return any(normalise_text(term) in text for term in LIVE_WORDS)


# ---------------------------------------------------------------------------
# Text used by retrieval and ThSM
# ---------------------------------------------------------------------------

def join_fields(row: pd.Series, fields: list[str]) -> str:
    parts = [text_value(row.get(field)) for field in fields]
    return " ".join(part.replace(";", " ") for part in parts if part)


def build_retrieval_text(row: pd.Series) -> str:
    """Keep the same searchable fields as the original hybrid search."""
    return join_fields(
        row,
        [
            "title",
            "meta_description",
            "extended_description",
            "topic_terms",
            "place_terms",
            "related_topic_terms",
            "related_place_terms",
            "years",
            "time_interval",
        ],
    )


def build_thematic_text(row: pd.Series) -> str:
    """Build the document-side text used specifically for ThSM."""
    thematic = join_fields(
        row,
        [
            "title",
            "meta_description",
            "extended_description",
            "topic_terms",
            "related_topic_terms",
        ],
    )
    return thematic or text_value(row.get("clean_text"))


def embedding_fingerprint(docs: pd.DataFrame) -> str:
    """Invalidate the cache when the corpus or text changes."""
    digest = hashlib.sha256()
    digest.update(MODEL_NAME.encode("utf-8"))
    for row in docs[["igv_id", "retrieval_text", "thematic_text"]].itertuples(index=False):
        digest.update(str(row.igv_id).encode("utf-8"))
        digest.update(row.retrieval_text.encode("utf-8", errors="ignore"))
        digest.update(row.thematic_text.encode("utf-8", errors="ignore"))
    return digest.hexdigest()[:16]


def load_or_create_embeddings(
    model: SentenceTransformer,
    docs: pd.DataFrame,
    cache_dir: Path,
) -> tuple[np.ndarray, np.ndarray]:
    """Cache full retrieval vectors and thematic-only vectors."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"igv_embeddings_{embedding_fingerprint(docs)}.npz"

    if cache_path.exists():
        cached = np.load(cache_path)
        return cached["retrieval_vectors"], cached["thematic_vectors"]

    print("Encoding profile retrieval text...")
    retrieval_vectors = model.encode(
        docs["retrieval_text"].tolist(),
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )

    print("Encoding profile thematic text...")
    thematic_vectors = model.encode(
        docs["thematic_text"].tolist(),
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    )

    np.savez_compressed(
        cache_path,
        retrieval_vectors=retrieval_vectors,
        thematic_vectors=thematic_vectors,
    )
    return retrieval_vectors, thematic_vectors


# ---------------------------------------------------------------------------
# Feature calculations
# ---------------------------------------------------------------------------

def coverage(query_values: set, document_values: set) -> float:
    """Matched query values divided by total query values."""
    if not query_values:
        return np.nan
    return len(query_values & document_values) / len(query_values)


def global_exact_match(document_places: set[str], document_text: str) -> bool:
    """Treat an explicitly global/worldwide profile as an exact global match."""
    if "global" in document_places:
        return True
    text = normalise_text(document_text)
    return any(word in text.split() for word in {"global", "worldwide", "world"})


def geo_exact_score(
    query_places: set[str],
    document_places: set[str],
    document_text: str,
) -> float:
    """GeoEM: exact query-place coverage."""
    if not query_places:
        return np.nan

    matched = 0
    for place in query_places:
        if place == "global":
            matched += int(global_exact_match(document_places, document_text))
        else:
            matched += int(place in document_places)
    return matched / len(query_places)


def one_geo_relation_score(
    query_place: str,
    document_places: set[str],
    related_places: set[str],
    document_text: str,
) -> float:
    """
    GeoRM rubric available from the current profile fields:
      exact = 1.00
      document is narrower than query = 0.75
      document is broader than query = 0.50
      no supported relation = 0.00
    """
    all_places = document_places | related_places

    if query_place == "global":
        return 1.0 if global_exact_match(all_places, document_text) else 0.0

    if query_place in document_places:
        return 1.0

    # A profile's related_place_terms commonly contains the parent country or region.
    if query_place in related_places:
        return RELATED_PLACE_SCORE

    if query_place == "north america" and all_places & NORTH_AMERICA_MEMBERS:
        return RELATED_PLACE_SCORE

    # Broader document coverage.
    if query_place == "united states" and "north america" in all_places:
        return BROADER_PLACE_SCORE
    if query_place in {"united states", "north america"} and global_exact_match(all_places, document_text):
        return BROADER_PLACE_SCORE

    return 0.0


def geo_related_score(
    query_places: set[str],
    document_places: set[str],
    related_places: set[str],
    document_text: str,
) -> float:
    """GeoRM: mean relationship score across all query places."""
    if not query_places:
        return np.nan
    scores = [
        one_geo_relation_score(place, document_places, related_places, document_text)
        for place in query_places
    ]
    return float(np.mean(scores))


def temporal_exact_score(
    query_text: str,
    query_start: int | None,
    query_end: int | None,
    document_years: set[int],
    document_text: str,
) -> float:
    """TempEM: endpoint-year coverage, or live-language matching."""
    if query_start is not None and query_end is not None:
        query_years = {query_start, query_end}
        return coverage(query_years, document_years)

    if contains_live_language(query_text):
        return 1.0 if contains_live_language(document_text) else 0.0

    return np.nan


def temporal_coverage_score(
    query_start: int | None,
    query_end: int | None,
    document_interval: tuple[int, int] | None,
) -> float:
    """TempCM: inclusive overlap divided by query interval length."""
    if query_start is None or query_end is None or document_interval is None:
        return np.nan

    document_start, document_end = document_interval
    overlap_years = max(
        0,
        min(query_end, document_end) - max(query_start, document_start) + 1,
    )
    query_years = query_end - query_start + 1
    return overlap_years / query_years


def safe_mean(first: float, second: float) -> float:
    """Mean only when both formula components exist."""
    if pd.isna(first) or pd.isna(second):
        return np.nan
    return (first + second) / 2.0


def score_features(
    query: pd.Series,
    document: pd.Series,
    thematic_vector: np.ndarray,
    query_thematic_vector: np.ndarray,
) -> dict[str, float]:
    """Calculate all agreed features for one query-IGV pair."""
    query_topics = split_terms(query["topic_terms"])
    document_topics = split_terms(document.get("topic_terms"))
    them = coverage(query_topics, document_topics)

    cosine = float(np.dot(query_thematic_vector, thematic_vector))
    thsm = float(np.clip((cosine + 1.0) / 2.0, 0.0, 1.0))

    query_places = split_places(query.get("places"))
    document_places = split_places(document.get("place_terms"))
    related_places = split_places(document.get("related_place_terms"))
    document_text = document["retrieval_text"]

    geoem = geo_exact_score(query_places, document_places, document_text)
    georm = geo_related_score(
        query_places,
        document_places,
        related_places,
        document_text,
    )

    query_start = number_or_none(query.get("start_year"))
    query_end = number_or_none(query.get("end_year"))
    document_years = parse_years(document.get("years"))
    document_interval = parse_interval(
        document.get("time_interval"),
        document.get("years"),
    )

    tempem = temporal_exact_score(
        text_value(query.get("query_text")),
        query_start,
        query_end,
        document_years,
        document_text,
    )
    tempcm = temporal_coverage_score(
        query_start,
        query_end,
        document_interval,
    )

    thematic_mean = safe_mean(them, thsm)
    geographic_mean = safe_mean(geoem, georm)
    temporal_mean = safe_mean(tempem, tempcm)

    tgi = (
        thematic_mean * geographic_mean
        if not pd.isna(thematic_mean) and not pd.isna(geographic_mean)
        else np.nan
    )
    tgti = (
        thematic_mean * geographic_mean * temporal_mean
        if not pd.isna(thematic_mean)
        and not pd.isna(geographic_mean)
        and not pd.isna(temporal_mean)
        else np.nan
    )

    return {
        "geo_applicable": bool(query_places),
        "temporal_applicable": bool(
            (query_start is not None and query_end is not None)
            or contains_live_language(query.get("query_text"))
        ),
        "ThEM": them,
        "ThSM": thsm,
        "GeoEM": geoem,
        "GeoRM": georm,
        "TempEM": tempem,
        "TempCM": tempcm,
        "TGI": tgi,
        "TGTI": tgti,
    }


# ---------------------------------------------------------------------------
# Retrieval and output
# ---------------------------------------------------------------------------

def validate_columns(df: pd.DataFrame, required: list[str], label: str) -> None:
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"{label} is missing columns: {missing}")


def rank_query(
    query_text: str,
    bm25: BM25Okapi,
    retrieval_vectors: np.ndarray,
    model: SentenceTransformer,
) -> pd.DataFrame:
    """Return sparse, dense and equal-weight RRF rankings for all profiles."""
    sparse_scores = bm25.get_scores(tokenize(query_text))

    query_vector = model.encode(
        BGE_QUERY_PREFIX + query_text,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    dense_scores = retrieval_vectors @ query_vector

    ranking = pd.DataFrame(
        {
            "document_index": np.arange(len(sparse_scores)),
            "sparse_score": sparse_scores,
            "dense_score": dense_scores,
        }
    )
    ranking["sparse_rank"] = ranking["sparse_score"].rank(
        method="min", ascending=False
    ).astype(int)
    ranking["dense_rank"] = ranking["dense_score"].rank(
        method="min", ascending=False
    ).astype(int)
    ranking["rrf_score"] = (
        1.0 / (RRF_K + ranking["sparse_rank"])
        + 1.0 / (RRF_K + ranking["dense_rank"])
    )

    ranking = ranking.sort_values(
        ["rrf_score", "dense_score", "sparse_score", "document_index"],
        ascending=[False, False, False, True],
        kind="mergesort",
    ).reset_index(drop=True)
    ranking["baseline_rank"] = np.arange(1, len(ranking) + 1)
    return ranking


def safe_filename(value: str) -> str:
    value = normalise_text(value).replace(" ", "_")
    return value or "query"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Hybrid retrieval and feature scoring for IGV profiles."
    )
    parser.add_argument(
        "--profiles",
        default="profiles(1).csv",
        help="Path to profiles CSV.",
    )
    parser.add_argument(
        "--queries",
        default="_queries_12_structured.csv",
        help="Path to structured query CSV.",
    )
    parser.add_argument(
        "--output",
        default="feature_results",
        help="Output directory.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=TOP_K,
        help="Number of baseline results retained per query.",
    )
    args = parser.parse_args()

    profiles_path = Path(args.profiles)
    queries_path = Path(args.queries)
    output_dir = Path(args.output)
    cache_dir = output_dir / ".cache"

    profiles = pd.read_csv(profiles_path)
    queries = pd.read_csv(queries_path)

    validate_columns(
        profiles,
        [
            "igv_id",
            "url",
            "status_flag",
            "title",
            "topic_terms",
            "place_terms",
            "years",
            "time_interval",
            "related_place_terms",
        ],
        "profiles CSV",
    )
    validate_columns(
        queries,
        [
            "query_id",
            "query_text",
            "topic_text",
            "topic_terms",
            "places",
            "start_year",
            "end_year",
        ],
        "queries CSV",
    )

    profiles = profiles[
        profiles["status_flag"].astype(str).str.lower().eq("usable")
    ].copy()
    profiles = profiles.reset_index(drop=True)
    if profiles.empty:
        raise ValueError("No profiles with status_flag == 'usable' were found.")

    profiles["retrieval_text"] = profiles.apply(build_retrieval_text, axis=1)
    profiles["thematic_text"] = profiles.apply(build_thematic_text, axis=1)

    print(f"Usable profiles: {len(profiles)}")
    print(f"Queries: {len(queries)}")
    print(f"Loading dense model: {MODEL_NAME}")

    model = SentenceTransformer(MODEL_NAME)
    retrieval_vectors, thematic_vectors = load_or_create_embeddings(
        model,
        profiles,
        cache_dir,
    )

    bm25 = BM25Okapi([tokenize(text) for text in profiles["retrieval_text"]])
    output_dir.mkdir(parents=True, exist_ok=True)

    all_results: list[pd.DataFrame] = []

    for _, query in queries.iterrows():
        query_id = text_value(query["query_id"])
        query_text = text_value(query["query_text"])
        query_topic_text = text_value(query["topic_text"])

        if not query_id or not query_text or not query_topic_text:
            raise ValueError(
                "Each query requires query_id, query_text and topic_text."
            )

        print(f"\nScoring {query_id}: {query_text}")
        ranking = rank_query(query_text, bm25, retrieval_vectors, model)
        top = ranking.head(args.top_k).copy()

        query_thematic_vector = model.encode(
            BGE_QUERY_PREFIX + query_topic_text,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )

        rows: list[dict] = []
        for rank_row in top.itertuples(index=False):
            document_index = int(rank_row.document_index)
            document = profiles.iloc[document_index]

            features = score_features(
                query,
                document,
                thematic_vectors[document_index],
                query_thematic_vector,
            )

            rows.append(
                {
                    "query_id": query_id,
                    "query_text": query_text,
                    "igv_id": document["igv_id"],
                    "title": text_value(document.get("title")),
                    "url": text_value(document.get("url")),
                    "baseline_rank": int(rank_row.baseline_rank),
                    "sparse_rank": int(rank_row.sparse_rank),
                    "dense_rank": int(rank_row.dense_rank),
                    "sparse_score": float(rank_row.sparse_score),
                    "dense_score": float(rank_row.dense_score),
                    "rrf_score": float(rank_row.rrf_score),
                    **features,
                }
            )

        result = pd.DataFrame(rows)
        numeric_columns = [
            "sparse_score",
            "dense_score",
            "rrf_score",
            "ThEM",
            "ThSM",
            "GeoEM",
            "GeoRM",
            "TempEM",
            "TempCM",
            "TGI",
            "TGTI",
        ]
        result[numeric_columns] = result[numeric_columns].round(4)

        query_output = output_dir / f"{safe_filename(query_id)}_top{args.top_k}.csv"
        result.to_csv(query_output, index=False, encoding="utf-8-sig")
        all_results.append(result)
        print(f"Saved {query_output}")

    combined = pd.concat(all_results, ignore_index=True)
    combined_output = output_dir / f"top{args.top_k}_all_queries_with_features.csv"
    combined.to_csv(combined_output, index=False, encoding="utf-8-sig")

    print("\nFinished.")
    print(f"Combined output: {combined_output}")
    print("Blank feature cells mean that the query did not supply that dimension.")


if __name__ == "__main__":
    main()
