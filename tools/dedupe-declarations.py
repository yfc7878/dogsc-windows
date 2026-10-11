"""
Removes duplicated top-level declarations.

The patch scripts in this session were applied twice by the sandbox, which left
several declarations defined twice. This keeps the first definition of each
top-level function and drops later duplicates, then reports what it removed.
"""
import io
import os
import re
import sys

os.chdir(r"D:\CXY\Documents\work\2026-10-10-17-25-20\DogSC-Windows")

DECL = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)


def dedupe_top_level(text):
    """Keeps the first definition of each top-level function."""
    removed = []
    while True:
        matches = list(DECL.finditer(text))
        seen = {}
        target = None
        for index, match in enumerate(matches):
            name = match.group(1)
            if name in seen:
                target = (seen[name], index, name, matches)
                break
            seen[name] = index
        if target is None:
            break
        first_index, duplicate_index, name, matches = target
        start = matches[duplicate_index].start()
        # The duplicate runs until the next top-level declaration after it.
        end = matches[duplicate_index + 1].start() if duplicate_index + 1 < len(matches) else len(text)
        text = text[:start] + text[end:]
        removed.append(name)
    return text, removed


for path in sys.argv[1:]:
    source = io.open(path, encoding="utf-8").read()
    fixed, removed = dedupe_top_level(source)
    if removed:
        io.open(path, "w", encoding="utf-8", newline="\n").write(fixed)
        print(f"{path}: removed duplicates of {sorted(set(removed))}")
    else:
        print(f"{path}: no duplicates")
