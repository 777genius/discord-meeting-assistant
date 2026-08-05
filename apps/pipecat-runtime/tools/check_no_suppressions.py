"""Fail the sidecar gate when a source-level static-analysis suppression appears."""

from __future__ import annotations

from pathlib import Path

FORBIDDEN_MARKERS = (
    "# no" + "qa",
    "# type" + ": ignore",
    "# pyright" + ": ignore",
    "# mypy" + ": ignore",
    "# ruff" + ": no" + "qa",
)


def main() -> None:
    """Check production and test Python source without treating generated code specially."""
    app_root = Path(__file__).resolve().parents[1]
    source_roots = (app_root / "src", app_root / "tests", app_root / "tools")
    violations: list[str] = []
    for source_root in source_roots:
        for source_file in source_root.rglob("*.py"):
            contents = source_file.read_text(encoding="utf-8")
            if any(marker in contents for marker in FORBIDDEN_MARKERS):
                violations.append(str(source_file.relative_to(app_root)))
    if violations:
        joined = ", ".join(sorted(violations))
        raise SystemExit(f"Python suppression markers are prohibited: {joined}")


if __name__ == "__main__":
    main()
