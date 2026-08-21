from pathlib import Path


def safe_output_path(output_dir, subfolder="", filename=None):
    """Resolve a path while keeping it inside ComfyUI's output directory."""
    root = Path(output_dir).expanduser().resolve()

    if "\0" in subfolder:
        raise ValueError("Subfolder contains an invalid character")

    candidate = root / subfolder
    if filename is not None:
        if not filename or "\0" in filename or Path(filename).name != filename:
            raise ValueError("Filename must be a single file name")
        candidate /= filename

    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("Path must stay inside the ComfyUI output directory") from exc

    return resolved


def bounded_int(value, default, minimum, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))
