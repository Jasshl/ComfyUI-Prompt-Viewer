import json
import re


SKIP_EXTENSIONS = {
    ".safetensors",
    ".gguf",
    ".pt",
    ".bin",
    ".ckpt",
    ".pth",
    ".yaml",
    ".json",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".mp4",
    ".txt",
    ".csv",
    ".log",
}

MIN_PROMPT_LENGTH = 30

NODE_STATUS = {
    0: "active",
    2: "muted",
    4: "bypassed",
}


def is_file_path_or_model(value):
    text = value.strip()
    if any(text.lower().endswith(extension) for extension in SKIP_EXTENSIONS):
        return True
    if re.match(r"^[a-zA-Z]?:?[\\/]", text):
        return True
    return "/" in text and "." in text.rsplit("/", 1)[-1]


def extract_prompts_from_workflow(
    workflow_json,
    mode="clean",
    allowed_fields=None,
    field_order=None,
    active_only=True,
):
    """Extract resolved text widgets from ComfyUI workflow metadata."""
    if mode not in {"clean", "debug", "custom", "discover"}:
        mode = "clean"

    try:
        workflow = (
            workflow_json
            if isinstance(workflow_json, dict)
            else json.loads(workflow_json)
        )
    except (json.JSONDecodeError, TypeError):
        return []

    nodes = workflow.get("nodes", [])
    if not isinstance(nodes, list):
        return []

    prompts = []
    for node in nodes:
        if not isinstance(node, dict):
            continue

        node_mode = node.get("mode", 0)
        if active_only and node_mode != 0:
            continue

        node_type = node.get("type", "Unknown")
        node_id = str(node.get("id", ""))
        title = node.get("title") or node_type
        node_status = NODE_STATUS.get(node_mode, f"mode {node_mode}")
        widgets = node.get("widgets_values", [])
        if not isinstance(widgets, list):
            continue

        for index, value in enumerate(widgets):
            if isinstance(value, list):
                texts = [item for item in value if isinstance(item, str)]
            elif isinstance(value, str):
                texts = [value]
            else:
                texts = []

            for text in texts:
                field_key = f"{node_type}::{node_id}::{index}"
                text = text.strip()
                if not text:
                    continue

                if mode == "clean" and (
                    len(text) < MIN_PROMPT_LENGTH or is_file_path_or_model(text)
                ):
                    continue
                if mode == "discover" and is_file_path_or_model(text):
                    continue
                if mode == "custom" and (
                    allowed_fields is None or field_key not in allowed_fields
                ):
                    continue

                prompts.append(
                    {
                        "node_id": node_id,
                        "node_type": node_type,
                        "node_title": title,
                        "field": f"widget_{index}",
                        "field_key": field_key,
                        "label": (
                            f"{title} - field {index + 1}"
                            if title != node_type
                            else f"{node_type} #{node_id} - field {index + 1}"
                        ),
                        "text": text,
                        "node_mode": node_mode,
                        "node_status": node_status,
                        "node_active": node_mode == 0,
                    }
                )

    if field_order:
        order = {key: index for index, key in enumerate(field_order)}
        prompts.sort(key=lambda prompt: order.get(prompt["field_key"], len(order)))

    return prompts
