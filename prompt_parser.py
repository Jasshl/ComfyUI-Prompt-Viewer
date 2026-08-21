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

TECHNICAL_NODE_TERMS = {
    "bookmark",
    "imagecache",
    "ksampler",
    "loadimage",
    "loader",
    "note",
    "previewimage",
    "randomnoise",
    "resolutionselector",
    "sampler",
    "saveimage",
    "scheduler",
    "stylemodelapply",
    "tasmartllm",
    "visionencode",
}

TECHNICAL_TITLE_WORDS = {
    "checkpoint",
    "device",
    "filename",
    "height",
    "model",
    "precision",
    "prefix",
    "resolution",
    "sampler",
    "scheduler",
    "seed",
    "width",
}

PROMPT_IDENTITY_TERMS = {
    "caption",
    "description",
    "instruction",
    "llm",
    "prompt",
    "string",
    "text",
}

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


def is_likely_prompt_field(node_type, node_title, value):
    """Return whether a string widget is likely to contain prompt text."""
    normalized_type = re.sub(r"[^a-z0-9]+", "", str(node_type).lower())
    normalized_title = re.sub(r"[^a-z0-9]+", " ", str(node_title).lower())
    title_words = set(normalized_title.split())

    if any(term in normalized_type for term in TECHNICAL_NODE_TERMS):
        return False
    if title_words & TECHNICAL_TITLE_WORDS:
        return False

    identity = f"{normalized_type} {normalized_title.replace(' ', '')}"
    if any(term in identity for term in PROMPT_IDENTITY_TERMS):
        return True

    text = value.strip()
    words = re.findall(r"\b[\w'-]+\b", text)
    return len(text) >= MIN_PROMPT_LENGTH and len(words) >= 5


def extract_prompts_from_workflow(
    workflow_json,
    mode="clean",
    allowed_fields=None,
    field_order=None,
    active_only=True,
    excluded_statuses=None,
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
        node_status = NODE_STATUS.get(node_mode, f"mode {node_mode}")
        if active_only and node_mode != 0:
            continue
        if excluded_statuses and node_status in excluded_statuses:
            continue

        node_type = node.get("type", "Unknown")
        node_id = str(node.get("id", ""))
        title = node.get("title") or node_type
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
                        "likely_prompt": is_likely_prompt_field(
                            node_type,
                            title,
                            text,
                        ),
                    }
                )

    if field_order:
        order = {key: index for index, key in enumerate(field_order)}
        prompts.sort(key=lambda prompt: order.get(prompt["field_key"], len(order)))

    return prompts
