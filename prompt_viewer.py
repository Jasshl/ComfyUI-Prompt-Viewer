import asyncio
import json
import os

from aiohttp import web
from PIL import Image

import folder_paths
from server import PromptServer

from .path_utils import bounded_int, safe_output_path
from .prompt_parser import extract_prompts_from_workflow


_ROUTES_REGISTERED = False


def _png_files(output_dir, subfolder="", limit=200):
    target_dir = safe_output_path(output_dir, subfolder)
    if not target_dir.is_dir():
        return []

    files = []
    for entry in os.scandir(target_dir):
        if not entry.is_file() or not entry.name.lower().endswith(".png"):
            continue
        try:
            files.append((entry.name, entry.stat().st_mtime, entry.path))
        except OSError:
            continue

    files.sort(key=lambda item: (item[1], item[0]), reverse=True)
    return files[:limit]


def _workflow_metadata(image_path):
    try:
        with Image.open(image_path) as image:
            workflow = getattr(image, "text", {}).get("workflow")
    except (OSError, ValueError):
        return None
    return workflow


def list_output_images(output_dir, subfolder="", limit=200):
    return [
        {"filename": filename, "subfolder": subfolder}
        for filename, _, _ in _png_files(output_dir, subfolder, limit)
    ]


def get_image_prompts(
    output_dir,
    subfolder,
    filename,
    mode="clean",
    allowed_fields=None,
    field_order=None,
):
    image_path = safe_output_path(output_dir, subfolder, filename)
    if image_path.suffix.lower() != ".png":
        return []

    workflow = _workflow_metadata(image_path)
    if workflow is None:
        return []

    return extract_prompts_from_workflow(
        workflow,
        mode=mode,
        allowed_fields=allowed_fields,
        field_order=field_order,
        active_only=mode == "clean",
    )


def search_output_prompts(
    output_dir,
    subfolder,
    query,
    mode="clean",
    limit=200,
    allowed_fields=None,
    field_order=None,
):
    query = query.casefold().strip()
    if not query:
        return []

    results = []
    for filename, _, image_path in _png_files(output_dir, subfolder, limit):
        workflow = _workflow_metadata(image_path)
        if workflow is None:
            continue
        prompts = extract_prompts_from_workflow(
            workflow,
            mode=mode,
            allowed_fields=allowed_fields,
            field_order=field_order,
            active_only=mode == "clean",
        )
        if any(query in prompt["text"].casefold() for prompt in prompts):
            results.append({"filename": filename, "subfolder": subfolder})
    return results


def discover_prompt_fields(output_dir, subfolder="", sample_size=30):
    seen = {}
    for filename, _, image_path in _png_files(output_dir, subfolder, sample_size):
        workflow = _workflow_metadata(image_path)
        if workflow is None:
            continue

        for prompt in extract_prompts_from_workflow(
            workflow,
            mode="discover",
            active_only=False,
        ):
            key = prompt["field_key"]
            if key in seen:
                continue
            _, widget_index = key.rsplit("::", 1)
            seen[key] = {
                "key": key,
                "node_id": prompt["node_id"],
                "node_type": prompt["node_type"],
                "widget_index": int(widget_index),
                "node_title": prompt["node_title"],
                "label": prompt["label"],
                "node_mode": prompt["node_mode"],
                "node_status": prompt["node_status"],
                "example": prompt["text"][:150],
                "example_source": filename,
            }
    return list(seen.values())


def list_output_subfolders(output_dir):
    root = safe_output_path(output_dir)
    subfolders = [""]
    if not root.is_dir():
        return subfolders

    for entry in os.scandir(root):
        if not entry.is_dir():
            continue
        try:
            safe_output_path(root, entry.name)
        except ValueError:
            continue
        subfolders.append(entry.name)
    return sorted(subfolders)


def _error_response(exc):
    return web.json_response({"error": str(exc)}, status=400)


def register_routes():
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return

    routes = PromptServer.instance.routes

    @routes.get("/history_tools/prompt_viewer/images")
    async def get_images(request):
        subfolder = request.query.get("subfolder", "")
        limit = bounded_int(request.query.get("limit"), 200, 1, 1000)
        try:
            results = await asyncio.to_thread(
                list_output_images,
                folder_paths.get_output_directory(),
                subfolder,
                limit,
            )
        except ValueError as exc:
            return _error_response(exc)
        return web.json_response(results)

    @routes.get("/history_tools/prompt_viewer/prompts")
    async def get_prompts(request):
        filename = request.query.get("filename", "")
        if not filename:
            return web.json_response([])

        mode = request.query.get("mode", "clean")
        fields = request.query.get("fields", "")
        order = request.query.get("order", "")
        allowed_fields = (
            set(filter(None, fields.split(","))) if mode == "custom" else None
        )
        field_order = list(filter(None, order.split(","))) if order else None

        try:
            prompts = await asyncio.to_thread(
                get_image_prompts,
                folder_paths.get_output_directory(),
                request.query.get("subfolder", ""),
                filename,
                mode,
                allowed_fields,
                field_order,
            )
        except ValueError as exc:
            return _error_response(exc)
        return web.json_response(prompts)

    @routes.get("/history_tools/prompt_viewer/search")
    async def search_prompts(request):
        query = request.query.get("q", "").strip()[:500]
        if not query:
            return web.json_response([])

        limit = bounded_int(request.query.get("limit"), 200, 1, 1000)
        mode = request.query.get("mode", "clean")
        fields = request.query.get("fields", "")
        order = request.query.get("order", "")
        allowed_fields = (
            set(filter(None, fields.split(","))) if mode == "custom" else None
        )
        field_order = list(filter(None, order.split(","))) if order else None
        try:
            results = await asyncio.to_thread(
                search_output_prompts,
                folder_paths.get_output_directory(),
                request.query.get("subfolder", ""),
                query,
                mode,
                limit,
                allowed_fields,
                field_order,
            )
        except ValueError as exc:
            return _error_response(exc)
        return web.json_response(results)

    @routes.get("/history_tools/prompt_viewer/discover_fields")
    async def discover_fields(request):
        sample_size = bounded_int(request.query.get("sample"), 30, 1, 200)
        try:
            results = await asyncio.to_thread(
                discover_prompt_fields,
                folder_paths.get_output_directory(),
                request.query.get("subfolder", ""),
                sample_size,
            )
        except (ValueError, json.JSONDecodeError) as exc:
            return _error_response(exc)
        return web.json_response(results)

    @routes.get("/history_tools/prompt_viewer/subfolders")
    async def get_subfolders(request):
        try:
            results = await asyncio.to_thread(
                list_output_subfolders,
                folder_paths.get_output_directory(),
            )
        except ValueError as exc:
            return _error_response(exc)
        return web.json_response(results)

    _ROUTES_REGISTERED = True
