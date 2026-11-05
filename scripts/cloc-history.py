#!/usr/bin/env nix
#! nix shell --impure --expr ``with import (builtins.getFlake "nixpkgs") {}; { inherit cloc; py = python3.withPackages (ps: [ ps.matplotlib ]); }`` cloc py --command python3
"""Graph lines of code per language across the repository's commits.

Runs cloc on every first-parent commit of a revision (and, with --worktree,
the uncommitted tracked files), then plots one line per language.

    scripts/cloc-history.py                     # writes cloc-history.png
    scripts/cloc-history.py -o out.png --csv out.csv --worktree
"""

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# Generated or vendored files that would swamp the hand-written code.
NOT_MATCH_F = r"(pnpm-lock\.yaml|Cargo\.lock)$"
NOT_MATCH_D = r"(src-tauri/gen|src/typst/pkg|node_modules|target|dist)(/|$)"

# Categorical order; the last slot is reserved for "Other".
COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#8a8984"]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def cloc(*target: str) -> dict[str, int]:
    out = subprocess.run(
        [
            "cloc",
            "--json",
            "--quiet",
            "--fullpath",
            f"--not-match-f={NOT_MATCH_F}",
            f"--not-match-d={NOT_MATCH_D}",
            *target,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if not out.strip():
        return {}
    data = json.loads(out)
    return {lang: v["code"] for lang, v in data.items() if lang not in ("header", "SUM")}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("rev", nargs="?", default="HEAD", help="revision to walk back from (default HEAD)")
    p.add_argument("-o", "--output", default="cloc-history.png", help="image to write (png, svg, pdf)")
    p.add_argument("--csv", help="also write the counts as CSV")
    p.add_argument("--top", type=int, default=7, help="languages to show; the rest become Other (max 7)")
    p.add_argument("--worktree", action="store_true", help="add a point for uncommitted tracked files")
    args = p.parse_args()
    top = max(1, min(args.top, len(COLORS) - 1))

    root = git("rev-parse", "--show-toplevel").strip()
    commits = [
        line.split("\x1f")
        for line in git("log", "--reverse", "--first-parent", "--format=%H\x1f%h\x1f%cs", args.rev).splitlines()
    ]

    labels: list[str] = []
    rows: list[dict[str, int]] = []
    for i, (sha, short, date) in enumerate(commits, 1):
        print(f"[{i}/{len(commits)}] {short} {date}", file=sys.stderr)
        rows.append(cloc("--git", sha))
        labels.append(f"{short}\n{date}")
    if args.worktree:
        print("[worktree]", file=sys.stderr)
        rows.append(cloc("--vcs=git", root))
        labels.append("worktree")

    if not rows:
        sys.exit("no commits")

    # Rank by the latest count so the biggest languages get the first colours.
    latest = rows[-1]
    langs = sorted({l for r in rows for l in r}, key=lambda l: (-latest.get(l, 0), l))
    shown, rest = langs[:top], langs[top:]
    series = {l: [r.get(l, 0) for r in rows] for l in shown}
    if rest:
        series["Other"] = [sum(r.get(l, 0) for l in rest) for r in rows]

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["commit", "date", *langs])
            for (sha, _, date), r in zip(commits, rows):
                w.writerow([sha, date, *(r.get(l, 0) for l in langs)])
            if args.worktree:
                w.writerow(["worktree", "", *(rows[-1].get(l, 0) for l in langs)])

    plot(series, labels, args.output, rest)
    print(f"wrote {args.output}", file=sys.stderr)


def plot(series: dict[str, list[int]], labels: list[str], output: str, rest: list[str]) -> None:
    ink, muted, grid = "#1f1f1e", "#6b6a64", "#e6e5e0"
    xs = range(len(labels))
    fig, ax = plt.subplots(figsize=(max(8, 0.55 * len(labels) + 4), 5.5), layout="constrained")

    colors = dict(zip(series, COLORS))
    if "Other" in series:
        colors["Other"] = COLORS[-1]
    for name, ys in series.items():
        ax.plot(xs, ys, color=colors[name], linewidth=2, marker="o" if len(labels) <= 40 else None,
                markersize=4, label=name, solid_capstyle="round")
        # Direct labels for the few largest series; the legend covers the rest.
        if list(series).index(name) < 4:
            ax.annotate(f"{name} {ys[-1]:,}", (xs[-1], ys[-1]), xytext=(6, 0), textcoords="offset points",
                        va="center", fontsize=9, color=ink)

    ax.set_title("Lines of code by language", loc="left", fontsize=13, color=ink)
    ax.set_ylabel("Code lines (excl. comments and blanks)", color=muted)
    ax.set_ylim(bottom=0)
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{int(v):,}"))
    step = max(1, len(labels) // 25)
    ax.set_xticks(list(xs)[::step], labels[::step], fontsize=8, color=muted)
    ax.tick_params(colors=muted, length=0)
    ax.grid(axis="y", color=grid, linewidth=1)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(grid)
    ax.margins(x=0.02)
    # Leave room on the right for the end labels.
    ax.set_xlim(right=len(labels) - 1 + max(0.6, len(labels) * 0.12))

    legend = ax.legend(loc="upper left", frameon=False, fontsize=9, labelcolor=ink)
    if rest:
        legend.set_title(f"Other: {', '.join(rest)}"[:80], prop={"size": 8})
        legend.get_title().set_color(muted)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=150, facecolor="white")


if __name__ == "__main__":
    main()
