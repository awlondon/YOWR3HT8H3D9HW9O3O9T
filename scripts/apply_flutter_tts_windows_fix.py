#!/usr/bin/env python3
"""Apply a production-safe flutter_tts Windows exclusion fix to a Flutter project.

This script updates pubspec.yaml so flutter_tts only declares Android/iOS platforms,
which prevents Windows plugin registration/build for flutter_tts.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def replace_flutter_tts_block(pubspec_text: str) -> tuple[str, bool]:
    lines = pubspec_text.splitlines(keepends=True)
    dep_start = None
    dep_indent = ""

    for i, line in enumerate(lines):
        m = re.match(r"^(\s*)flutter_tts\s*:\s*(?:#.*)?$", line)
        if m:
            dep_start = i
            dep_indent = m.group(1)
            break

    if dep_start is None:
        return pubspec_text, False

    end = dep_start + 1
    while end < len(lines):
        line = lines[end]
        if not line.strip():
            end += 1
            continue
        current_indent = len(line) - len(line.lstrip(" "))
        base_indent = len(dep_indent)
        if current_indent <= base_indent and not line.lstrip().startswith("#"):
            break
        end += 1

    new_block = (
        f"{dep_indent}flutter_tts:\n"
        f"{dep_indent}  platforms:\n"
        f"{dep_indent}    android:\n"
        f"{dep_indent}    ios:\n"
    )

    replaced = "".join(lines[:dep_start]) + new_block + "".join(lines[end:])
    return replaced, True


def find_flutter_tts_imports(project_root: Path) -> list[Path]:
    results: list[Path] = []
    for dart_file in project_root.rglob("*.dart"):
        try:
            content = dart_file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if "import 'package:flutter_tts/flutter_tts.dart'" in content or 'import "package:flutter_tts/flutter_tts.dart"' in content:
            results.append(dart_file)
    return sorted(results)


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply flutter_tts Windows exclusion fix.")
    parser.add_argument("--project-root", default=".", help="Path to Flutter project root (default: current directory)")
    parser.add_argument("--check", action="store_true", help="Check only; do not write changes")
    args = parser.parse_args()

    root = Path(args.project_root).resolve()
    pubspec = root / "pubspec.yaml"

    if not pubspec.exists():
        print(f"ERROR: pubspec.yaml not found at {pubspec}", file=sys.stderr)
        return 1

    original = pubspec.read_text(encoding="utf-8")
    updated, found = replace_flutter_tts_block(original)

    if not found:
        print("ERROR: flutter_tts dependency not found in pubspec.yaml", file=sys.stderr)
        return 1

    changed = updated != original
    if args.check:
        if changed:
            print("NEEDS_UPDATE: flutter_tts block should be platform-restricted to android/ios.")
            return 2
        print("OK: flutter_tts block already platform-restricted.")
    else:
        if changed:
            pubspec.write_text(updated, encoding="utf-8")
            print(f"UPDATED: {pubspec}")
        else:
            print("NO_CHANGE: pubspec.yaml already has desired flutter_tts platform block.")

    imports = find_flutter_tts_imports(root)
    if imports:
        print("\nflutter_tts import locations:")
        for file in imports:
            print(f" - {file.relative_to(root)}")
        if len(imports) > 1:
            print(
                "WARNING: Multiple dart files import flutter_tts directly. "
                "Keep plugin import centralized (e.g., voice_mobile.dart).",
                file=sys.stderr,
            )
    else:
        print("\nNo direct flutter_tts dart imports found.")

    print("\nNext commands:")
    print("  flutter clean")
    print("  flutter pub get")
    print("  flutter run -d windows")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
