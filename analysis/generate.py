#!/usr/bin/env python3
"""Generate deterministic thesis artifacts from one verified CSV snapshot."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


REQUIRED_COLUMNS: dict[str, list[str]] = {
    "runs.csv": [
        "run_id", "retailer_id", "retailer_name", "collection_day", "stage",
        "status", "attempted", "ok", "failed", "success_rate", "strategy_id",
        "strategy_version", "started_at", "finished_at", "error_category",
    ],
    "healing_events.csv": [
        "event_id", "retailer_id", "retailer_name", "purpose", "status",
        "onset_run_id", "previous_strategy_id", "successor_strategy_id", "attempts",
        "tier_from", "tier_to", "drift_started_at", "detected_at", "recovered_at",
        "duration_seconds",
    ],
    "aggregate_daily.csv": [
        "date", "previous_date", "chain_segment", "daily_relative", "index_level",
        "covered_weight_pct_total_ipca", "total_food_at_home_weight_pct_total_ipca",
        "coverage_fraction", "covered_subitem_count", "retailer_count",
        "product_pair_count", "descriptive_low_relative", "descriptive_high_relative",
        "method_version",
    ],
    "coverage_daily.csv": [
        "date", "covered_weight_pct_total_ipca",
        "total_food_at_home_weight_pct_total_ipca", "coverage_fraction",
        "covered_subitem_count", "retailer_count", "product_pair_count",
        "unclassified_count", "no_healthy_run_count", "unavailable_count",
        "carried_expired_count", "no_denominator_count", "invalid_price_count",
    ],
    "monthly_comparison.csv": [
        "month", "experimental_variation_pct", "official_variation_pct", "status",
        "experimental_chain_segment",
    ],
}

COLORS = {
    "blue": "#1769AA",
    "orange": "#E07A1F",
    "green": "#2E7D32",
    "red": "#C62828",
    "gray": "#616161",
    "light": "#DCEAF7",
}
PNG_METADATA = {"Software": "bpp-brasil-tcc M6 reproducible analysis"}
CAVEATS = [
    "sem validação estatística",
    "não é intervalo de confiança",
    "índice experimental e faixa descritiva entre varejistas",
    "preço promocional quando positivo; carregamento por produto limitado a sete dias",
    "média igual entre varejistas e pesos POF renormalizados sobre subitens cobertos",
    "painel por CEP e série oficial SNIPC São Paulo N7 têm definições geográficas distintas",
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def inside(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    if candidate_resolved != root_resolved and root_resolved not in candidate_resolved.parents:
        raise ValueError(f"path escapes root: {candidate}")
    return candidate_resolved


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def resolve_input(path: Path) -> tuple[Path, dict[str, Any], bytes]:
    root = path.resolve()
    latest_path = root / "latest.json"
    if latest_path.is_file():
        latest = read_json(latest_path)
        relative_snapshot = latest.get("snapshotDirectory")
        if not isinstance(relative_snapshot, str) or Path(relative_snapshot).is_absolute():
            raise ValueError("latest snapshot path must be relative")
        snapshot = inside(root, root / relative_snapshot)
    else:
        snapshot = root
    manifest_path = snapshot / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise ValueError("unsupported input manifest")
    snapshot_id = manifest.get("snapshotId")
    if not isinstance(snapshot_id, str) or not snapshot_id or "/" in snapshot_id or ".." in snapshot_id:
        raise ValueError("unsafe input snapshot ID")
    return snapshot, manifest, manifest_bytes


def verified_frames(snapshot: Path, manifest: dict[str, Any]) -> dict[str, pd.DataFrame]:
    listed = manifest.get("files")
    if not isinstance(listed, list):
        raise ValueError("input manifest files must be an array")
    evidence: dict[str, dict[str, Any]] = {}
    for item in listed:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("invalid input file evidence")
        name = item["path"]
        if name in evidence:
            raise ValueError(f"duplicate input file evidence: {name}")
        evidence[name] = item

    frames: dict[str, pd.DataFrame] = {}
    for name, expected_columns in REQUIRED_COLUMNS.items():
        item = evidence.get(name)
        if item is None:
            raise ValueError(f"required input is absent from manifest: {name}")
        if Path(name).is_absolute() or Path(name).name != name:
            raise ValueError(f"unsafe input filename: {name}")
        path = inside(snapshot, snapshot / name)
        data = path.read_bytes()
        if item.get("sha256") != sha256(data) or item.get("bytes") != len(data):
            raise ValueError(f"input hash/size mismatch: {name}")
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, None)
            if header != expected_columns or len(header or []) != len(set(header or [])):
                raise ValueError(f"invalid columns: {name}")
            rows = sum(1 for _ in reader)
        if item.get("rows") != rows or item.get("columns") != expected_columns:
            raise ValueError(f"input row/schema evidence mismatch: {name}")
        frames[name] = pd.read_csv(
            path,
            dtype=str,
            keep_default_na=False,
            na_filter=False,
        )
    return frames


def parse_nonnegative_integer(frame: pd.DataFrame, column: str, label: str) -> pd.Series:
    if frame.empty:
        return pd.Series(dtype="int64")
    values = pd.to_numeric(frame[column], errors="raise")
    if ((values % 1) != 0).any() or (values < 0).any():
        raise ValueError(f"{label}.{column} must contain non-negative integers")
    return values.astype("int64")


def parse_decimal_column(
    frame: pd.DataFrame,
    column: str,
    label: str,
    *,
    allow_empty: bool = False,
    minimum: float | None = None,
    maximum: float | None = None,
) -> pd.Series:
    if frame.empty:
        return pd.Series(dtype="float64")
    source = frame[column].replace("", np.nan) if allow_empty else frame[column]
    values = pd.to_numeric(source, errors="raise")
    present = values.dropna()
    if not np.isfinite(present).all():
        raise ValueError(f"{label}.{column} must contain finite numbers")
    if minimum is not None and (present < minimum).any():
        raise ValueError(f"{label}.{column} is outside its non-negative/range constraint")
    if maximum is not None and (present > maximum).any():
        raise ValueError(f"{label}.{column} is outside its range constraint")
    return values


def validate_frames(frames: dict[str, pd.DataFrame]) -> None:
    runs = frames["runs.csv"]
    if not runs.empty:
        pd.to_datetime(runs["collection_day"], format="%Y-%m-%d", errors="raise")
    healing = frames["healing_events.csv"]
    if not healing.empty:
        parse_nonnegative_integer(healing, "attempts", "healing_events")
        parse_decimal_column(
            healing,
            "duration_seconds",
            "healing_events",
            allow_empty=True,
            minimum=0,
        )
        for column in ["drift_started_at", "detected_at"]:
            pd.to_datetime(healing[column], utc=True, errors="raise")
        recovered = healing.loc[healing["recovered_at"] != "", "recovered_at"]
        if not recovered.empty:
            pd.to_datetime(recovered, utc=True, errors="raise")

    aggregate = frames["aggregate_daily.csv"]
    if not aggregate.empty:
        pd.to_datetime(aggregate["date"], format="%Y-%m-%d", errors="raise")
        for column in ["chain_segment", "covered_subitem_count", "retailer_count", "product_pair_count"]:
            values = parse_nonnegative_integer(aggregate, column, "aggregate_daily")
            if column == "chain_segment" and (values < 1).any():
                raise ValueError("aggregate_daily.chain_segment must be positive")
        for column in [
            "covered_weight_pct_total_ipca",
            "total_food_at_home_weight_pct_total_ipca",
        ]:
            parse_decimal_column(aggregate, column, "aggregate_daily", minimum=0)
        parse_decimal_column(
            aggregate, "coverage_fraction", "aggregate_daily", minimum=0, maximum=1
        )
        for column in [
            "daily_relative", "index_level", "descriptive_low_relative",
            "descriptive_high_relative",
        ]:
            values = parse_decimal_column(
                aggregate, column, "aggregate_daily", allow_empty=True, minimum=0
            )
            if (values.dropna() == 0).any():
                raise ValueError(f"aggregate_daily.{column} must be positive when present")

    coverage = frames["coverage_daily.csv"]
    if not coverage.empty:
        pd.to_datetime(coverage["date"], format="%Y-%m-%d", errors="raise")
        for column in [
            "covered_subitem_count", "retailer_count", "product_pair_count",
            "unclassified_count", "no_healthy_run_count", "unavailable_count",
            "carried_expired_count", "no_denominator_count", "invalid_price_count",
        ]:
            parse_nonnegative_integer(coverage, column, "coverage_daily")
        for column in [
            "covered_weight_pct_total_ipca", "total_food_at_home_weight_pct_total_ipca",
        ]:
            parse_decimal_column(coverage, column, "coverage_daily", minimum=0)
        parse_decimal_column(
            coverage, "coverage_fraction", "coverage_daily", minimum=0, maximum=1
        )

    monthly = frames["monthly_comparison.csv"]
    if not monthly.empty:
        pd.to_datetime(monthly["month"], format="%Y-%m", errors="raise")
        for column in ["experimental_variation_pct", "official_variation_pct"]:
            parse_decimal_column(monthly, column, "monthly_comparison", allow_empty=True)
        parse_decimal_column(
            monthly,
            "experimental_chain_segment",
            "monthly_comparison",
            allow_empty=True,
            minimum=1,
        )


def validate_and_daily_success(runs: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float]]:
    if runs.empty:
        return pd.DataFrame(columns=["retailer_id", "retailer_name", "date", "attempted", "ok", "rate"]), {}
    attempted = parse_nonnegative_integer(runs, "attempted", "runs")
    ok = parse_nonnegative_integer(runs, "ok", "runs")
    failed = parse_nonnegative_integer(runs, "failed", "runs")
    if not (attempted == ok + failed).all():
        raise ValueError("run counters violate attempted = ok + failed")
    dates = pd.to_datetime(runs["collection_day"], format="%Y-%m-%d", errors="raise")
    selected = runs.assign(attempted_num=attempted, ok_num=ok, parsed_date=dates)
    selected = selected[
        (selected["stage"] == "collect")
        & selected["status"].isin(["completed", "partial", "failed"])
    ]
    grouped = (
        selected.groupby(["retailer_id", "retailer_name", "parsed_date"], sort=True, as_index=False)
        .agg(attempted=("attempted_num", "sum"), ok=("ok_num", "sum"))
    )
    grouped["rate"] = np.where(grouped["attempted"] > 0, grouped["ok"] / grouped["attempted"], np.nan)
    summaries = {
        f"{row.retailer_id}:{row.parsed_date.strftime('%Y-%m-%d')}": round(float(row.rate), 12)
        for row in grouped.itertuples()
        if not pd.isna(row.rate)
    }
    return grouped.rename(columns={"parsed_date": "date"}), summaries


def configure_plots() -> None:
    matplotlib.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "axes.titlesize": 15,
        "axes.labelsize": 12,
        "legend.fontsize": 10,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
        "axes.grid": True,
        "grid.alpha": 0.25,
        "path.simplify": False,
    })


def save_success_rate(
    path: Path, daily: pd.DataFrame, healing: pd.DataFrame
) -> list[str] | None:
    fig, ax = plt.subplots(figsize=(16, 9), dpi=100)
    date_limits: list[str] | None = None
    if daily.empty:
        ax.text(0.5, 0.55, "Sem execuções de coleta disponíveis", ha="center", va="center", transform=ax.transAxes, fontsize=17)
        ax.text(0.5, 0.47, "Lacunas não são retropreenchidas", ha="center", va="center", transform=ax.transAxes, color=COLORS["gray"])
    else:
        palette = [COLORS["blue"], COLORS["orange"], COLORS["green"], COLORS["red"]]
        for index, ((retailer_id, retailer_name), group) in enumerate(
            daily.groupby(["retailer_id", "retailer_name"], sort=True)
        ):
            ordered = group.sort_values("date").set_index("date")
            complete_days = pd.date_range(ordered.index.min(), ordered.index.max(), freq="D")
            values = ordered["rate"].reindex(complete_days)
            ax.plot(complete_days, values * 100, marker="o", linewidth=2, markersize=4,
                    color=palette[index % len(palette)], label=f"{retailer_name} ({retailer_id})")
        ax.axhline(70, color=COLORS["red"], linestyle="--", linewidth=1.5, label="limiar de deriva (70%)")
        if not healing.empty:
            for row in healing.sort_values(["detected_at", "event_id"]).itertuples():
                detected = pd.to_datetime(row.detected_at, utc=True, errors="raise").tz_convert("America/Sao_Paulo").tz_localize(None)
                ax.axvline(detected, color=COLORS["orange"], alpha=0.45, linewidth=1)
                if row.recovered_at:
                    recovered = pd.to_datetime(row.recovered_at, utc=True, errors="raise").tz_convert("America/Sao_Paulo").tz_localize(None)
                    ax.axvline(recovered, color=COLORS["green"], alpha=0.45, linewidth=1)
        ax.set_ylim(-2, 102)
        lower = daily["date"].min() - pd.Timedelta(days=1)
        upper = daily["date"].max() + pd.Timedelta(days=1)
        ax.set_xlim(lower, upper)
        date_limits = [lower.strftime("%Y-%m-%d"), upper.strftime("%Y-%m-%d")]
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=1))
        ax.legend(loc="lower left", ncols=2)
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m/%Y"))
    ax.set_title("Taxa diária de sucesso da extração por varejista")
    ax.set_xlabel("Data de coleta (America/Sao_Paulo)")
    ax.set_ylabel("Tentativas bem-sucedidas (%)")
    fig.text(0.01, 0.01, "Inclui tentativas que falharam; dias sem coleta aparecem como lacunas e não são retropreenchidos.", color=COLORS["gray"], fontsize=9)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(path, dpi=100, metadata=PNG_METADATA)
    plt.close(fig)
    return date_limits


def numeric(frame: pd.DataFrame, column: str) -> pd.Series:
    if frame.empty:
        return pd.Series(dtype="float64")
    replaced = frame[column].replace("", np.nan)
    return pd.to_numeric(replaced, errors="raise")


def save_index_comparison(
    path: Path,
    aggregate: pd.DataFrame,
    coverage: pd.DataFrame,
    monthly: pd.DataFrame,
) -> tuple[bool, bool]:
    fig, (ax_index, ax_monthly) = plt.subplots(2, 1, figsize=(16, 12), dpi=100, gridspec_kw={"height_ratios": [2, 1]})
    no_index = aggregate.empty or not (aggregate["index_level"] != "").any()
    if no_index:
        ax_index.text(0.5, 0.55, "Índice ainda indisponível", ha="center", va="center", transform=ax_index.transAxes, fontsize=17)
        ax_index.text(0.5, 0.46, "Não há pares de preços classificados suficientes", ha="center", va="center", transform=ax_index.transAxes, color=COLORS["gray"])
    else:
        working = aggregate.copy()
        working["parsed_date"] = pd.to_datetime(working["date"], format="%Y-%m-%d", errors="raise")
        working["level"] = numeric(working, "index_level")
        working["low_relative"] = numeric(working, "descriptive_low_relative")
        working["high_relative"] = numeric(working, "descriptive_high_relative")
        for segment, group in working.groupby("chain_segment", sort=True):
            ordered = group.sort_values("parsed_date")
            ax_index.plot(ordered["parsed_date"], ordered["level"], marker="o", linewidth=2,
                          color=COLORS["blue"], label="índice experimental" if str(segment) == str(working["chain_segment"].iloc[0]) else None)
            valid_band = ordered["low_relative"].notna() & ordered["high_relative"].notna()
            if valid_band.any():
                low_levels: list[float] = []
                high_levels: list[float] = []
                low_level = 100.0
                high_level = 100.0
                for row in ordered.itertuples():
                    if pd.isna(row.low_relative) or pd.isna(row.high_relative):
                        low_levels.append(np.nan)
                        high_levels.append(np.nan)
                    else:
                        low_level *= float(row.low_relative)
                        high_level *= float(row.high_relative)
                        low_levels.append(low_level)
                        high_levels.append(high_level)
                ax_index.fill_between(ordered["parsed_date"], low_levels, high_levels,
                                      color=COLORS["light"], alpha=0.65,
                                      label="faixa descritiva entre varejistas" if str(segment) == str(working["chain_segment"].iloc[0]) else None)
        if not coverage.empty:
            coverage_dates = pd.to_datetime(coverage["date"], format="%Y-%m-%d", errors="raise")
            coverage_values = numeric(coverage, "coverage_fraction") * 100
            coverage_axis = ax_index.twinx()
            coverage_axis.plot(coverage_dates, coverage_values, color=COLORS["gray"], linestyle=":", linewidth=1.5, label="cobertura de peso")
            coverage_axis.set_ylabel("Cobertura do peso alimentação no domicílio (%)")
            coverage_axis.set_ylim(0, 105)
        ax_index.legend(loc="best")
        ax_index.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m/%Y"))
    ax_index.set_title("Índice experimental diário e cobertura")
    ax_index.set_ylabel("Nível (base 100 por segmento)")

    overlap = monthly[(monthly["status"] == "overlap") & (monthly["experimental_variation_pct"] != "") & (monthly["official_variation_pct"] != "")]
    no_overlap = overlap.empty
    if no_overlap:
        ax_monthly.text(0.5, 0.53, "Sem meses fechados em comum com a série oficial", ha="center", va="center", transform=ax_monthly.transAxes, fontsize=15)
        ax_monthly.text(0.5, 0.43, "Nenhum valor oficial foi interpolado ou substituído por zero", ha="center", va="center", transform=ax_monthly.transAxes, color=COLORS["gray"])
    else:
        months = pd.to_datetime(overlap["month"], format="%Y-%m", errors="raise")
        experimental = pd.to_numeric(overlap["experimental_variation_pct"], errors="raise")
        official = pd.to_numeric(overlap["official_variation_pct"], errors="raise")
        positions = np.arange(len(months))
        width = 0.36
        ax_monthly.bar(positions - width / 2, experimental, width, color=COLORS["blue"], label="experimental")
        ax_monthly.bar(positions + width / 2, official, width, color=COLORS["orange"], label="IPCA/SIDRA 7060")
        ax_monthly.set_xticks(positions, [month.strftime("%m/%Y") for month in months])
        ax_monthly.axhline(0, color="black", linewidth=0.8)
        ax_monthly.legend(loc="best")
    ax_monthly.set_title("Variação mensal em meses fechados comuns")
    ax_monthly.set_ylabel("Variação mensal (%)")
    ax_monthly.set_xlabel("Mês")
    fig.text(0.01, 0.012, "Índice experimental; sem validação estatística. Faixa descritiva; não é intervalo de confiança. CEP do painel e área SNIPC São Paulo N7 diferem.", color=COLORS["gray"], fontsize=9)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(path, dpi=100, metadata=PNG_METADATA)
    plt.close(fig)
    return no_index, no_overlap


def stable_csv(path: Path, columns: list[str], rows: list[list[Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(columns)
        writer.writerows(rows)


def healing_table(path: Path, healing: pd.DataFrame) -> None:
    columns = [
        "event_id", "retailer_name", "status", "healed_automatically", "detected_at",
        "recovered_at", "attempts", "tier_transition", "duration_hours",
    ]
    rows: list[list[Any]] = []
    for row in healing.sort_values(["detected_at", "event_id"]).itertuples():
        attempts = int(row.attempts) if row.attempts else 0
        duration_hours = "" if not row.duration_seconds else f"{int(row.duration_seconds) / 3600:.3f}"
        transition = "" if not row.tier_from else f"{row.tier_from}→{row.tier_to or '?'}"
        healed = row.status == "recovered" and bool(row.successor_strategy_id)
        rows.append([
            row.event_id, row.retailer_name, row.status, str(healed).lower(), row.detected_at,
            row.recovered_at, attempts, transition, duration_hours,
        ])
    stable_csv(path, columns, rows)


def coverage_table(path: Path, aggregate: pd.DataFrame, coverage: pd.DataFrame) -> None:
    columns = [
        "date", "chain_segment", "index_level", "coverage_fraction", "retailer_count",
        "product_pair_count", "descriptive_low_relative", "descriptive_high_relative",
    ]
    if aggregate.empty:
        stable_csv(path, columns, [])
        return
    selected = aggregate[[
        "date", "chain_segment", "index_level", "retailer_count", "product_pair_count",
        "descriptive_low_relative", "descriptive_high_relative",
    ]].copy()
    coverage_values = coverage[["date", "coverage_fraction"]] if not coverage.empty else pd.DataFrame(columns=["date", "coverage_fraction"])
    merged = selected.merge(coverage_values, on="date", how="left").sort_values(["date", "chain_segment"])
    stable_csv(path, columns, [[
        row.date, row.chain_segment, row.index_level, row.coverage_fraction,
        row.retailer_count, row.product_pair_count, row.descriptive_low_relative,
        row.descriptive_high_relative,
    ] for row in merged.itertuples()])


def output_evidence(directory: Path, names: list[str]) -> list[dict[str, Any]]:
    evidence = []
    for name in names:
        data = (directory / name).read_bytes()
        rows = None
        if name.endswith(".csv"):
            with (directory / name).open("r", encoding="utf-8", newline="") as handle:
                rows = max(0, sum(1 for _ in csv.reader(handle)) - 1)
        evidence.append({"path": name, "sha256": sha256(data), "bytes": len(data), "rows": rows})
    return evidence


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}-", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def generate(input_path: Path, output_root: Path) -> dict[str, Any]:
    snapshot, input_manifest, input_manifest_bytes = resolve_input(input_path)
    frames = verified_frames(snapshot, input_manifest)
    validate_frames(frames)
    snapshot_id = str(input_manifest["snapshotId"])
    output_root = output_root.resolve()
    snapshots_root = output_root / "snapshots"
    snapshots_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    final = inside(output_root, snapshots_root / snapshot_id)
    if final.exists():
        manifest = read_json(final / "manifest.json")
        if manifest.get("input", {}).get("manifestSha256") != sha256(input_manifest_bytes):
            raise ValueError("input manifest changed for an existing snapshot ID")
        atomic_json(output_root / "latest.json", {
            "schemaVersion": 1,
            "snapshotId": snapshot_id,
            "snapshotDirectory": f"snapshots/{snapshot_id}",
            "manifestSha256": sha256((final / "manifest.json").read_bytes()),
        })
        return {
            "status": input_manifest.get("status", "complete"),
            "snapshotId": snapshot_id,
            "snapshotDirectory": f"snapshots/{snapshot_id}",
            "officialOverlap": not bool(manifest["statuses"]["noOfficialOverlap"]),
        }

    configure_plots()
    temporary = Path(tempfile.mkdtemp(prefix=".analysis-", suffix=".tmp", dir=output_root))
    try:
        daily, daily_summaries = validate_and_daily_success(frames["runs.csv"])
        healing = frames["healing_events.csv"]
        aggregate = frames["aggregate_daily.csv"]
        coverage = frames["coverage_daily.csv"]
        monthly = frames["monthly_comparison.csv"]
        success_date_limits = save_success_rate(
            temporary / "success-rate.png", daily, healing
        )
        healing_table(temporary / "healing-events.csv", healing)
        no_index, no_overlap = save_index_comparison(
            temporary / "index-vs-ipca.png", aggregate, coverage, monthly
        )
        coverage_table(temporary / "index-coverage-and-dispersion.csv", aggregate, coverage)
        output_names = [
            "success-rate.png", "healing-events.csv", "index-vs-ipca.png",
            "index-coverage-and-dispersion.csv",
        ]
        manifest = {
            "schemaVersion": 1,
            "snapshotId": snapshot_id,
            "generatedAt": input_manifest.get("generatedAt"),
            "methodVersion": input_manifest.get("methodVersion"),
            "input": {
                "manifestSha256": sha256(input_manifest_bytes),
                "snapshotId": snapshot_id,
            },
            "versions": {
                "python": sys.version.split()[0],
                "pandas": pd.__version__,
                "numpy": np.__version__,
                "matplotlib": matplotlib.__version__,
            },
            "plotting": {
                "backend": "Agg",
                "font": "DejaVu Sans",
                "successRatePixels": [1600, 900],
                "indexComparisonPixels": [1600, 1200],
                "successRateDateLimits": success_date_limits,
                "successRateDateLocator": "daily",
            },
            "statuses": {
                "noIndexData": no_index,
                "noOfficialOverlap": no_overlap,
            },
            "summaries": {"dailySuccessRates": daily_summaries},
            "caveats": CAVEATS,
            "outputs": output_evidence(temporary, output_names),
        }
        manifest_path = temporary / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(manifest_path, 0o600)
        for path in temporary.iterdir():
            os.chmod(path, 0o600)
        os.replace(temporary, final)
        manifest_bytes = (final / "manifest.json").read_bytes()
        atomic_json(output_root / "latest.json", {
            "schemaVersion": 1,
            "snapshotId": snapshot_id,
            "snapshotDirectory": f"snapshots/{snapshot_id}",
            "manifestSha256": sha256(manifest_bytes),
        })
        status = str(input_manifest.get("status", "complete"))
        return {
            "status": status,
            "snapshotId": snapshot_id,
            "snapshotDirectory": f"snapshots/{snapshot_id}",
            "officialOverlap": not no_overlap,
        }
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        result = generate(args.input, args.output)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n")
        return 0
    except Exception as error:  # publication boundary: one concise safe error
        sys.stderr.write(f"analysis: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
