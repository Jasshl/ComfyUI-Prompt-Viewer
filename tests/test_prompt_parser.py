import json
import unittest

from prompt_parser import (
    extract_prompts_from_workflow,
    is_file_path_or_model,
    is_likely_prompt_field,
)


class PromptParserTests(unittest.TestCase):
    def setUp(self):
        self.workflow = json.dumps(
            {
                "nodes": [
                    {
                        "id": 1,
                        "type": "TextInput",
                        "title": "Positive Prompt",
                        "mode": 0,
                        "widgets_values": [
                            "short prompt",
                            "A detailed description of a moonlit city street at night.",
                            "models/checkpoint.safetensors",
                        ],
                    },
                    {
                        "id": 2,
                        "type": "SceneText",
                        "title": "Scene",
                        "mode": 0,
                        "widgets_values": [
                            "Soft window light falling across an otherwise empty room."
                        ],
                    },
                    {
                        "id": 3,
                        "type": "MutedText",
                        "mode": 2,
                        "widgets_values": [
                            "A long text value from a node that is currently muted."
                        ],
                    },
                ]
            }
        )

    def test_clean_mode_returns_long_active_text_fields(self):
        prompts = extract_prompts_from_workflow(self.workflow)
        self.assertEqual(
            [prompt["field_key"] for prompt in prompts],
            ["TextInput::1::1", "SceneText::2::0"],
        )

    def test_debug_mode_includes_short_muted_and_file_values(self):
        prompts = extract_prompts_from_workflow(
            self.workflow,
            mode="debug",
            active_only=False,
        )
        texts = [prompt["text"] for prompt in prompts]
        self.assertIn("short prompt", texts)
        self.assertIn("models/checkpoint.safetensors", texts)
        self.assertIn(
            "A long text value from a node that is currently muted.", texts
        )

    def test_discover_mode_includes_short_text_but_not_file_values(self):
        prompts = extract_prompts_from_workflow(self.workflow, mode="discover")
        texts = [prompt["text"] for prompt in prompts]
        self.assertIn("short prompt", texts)
        self.assertNotIn("models/checkpoint.safetensors", texts)

    def test_custom_mode_filters_and_orders_fields(self):
        prompts = extract_prompts_from_workflow(
            self.workflow,
            mode="custom",
            allowed_fields={"SceneText::2::0", "TextInput::1::0"},
            field_order=["SceneText::2::0", "TextInput::1::0"],
        )
        self.assertEqual(
            [prompt["field_key"] for prompt in prompts],
            ["SceneText::2::0", "TextInput::1::0"],
        )
        self.assertEqual(prompts[1]["text"], "short prompt")

    def test_custom_mode_without_selected_fields_returns_nothing(self):
        prompts = extract_prompts_from_workflow(
            self.workflow,
            mode="custom",
            allowed_fields=set(),
        )
        self.assertEqual(prompts, [])

    def test_same_node_type_fields_have_distinct_keys(self):
        workflow = {
            "nodes": [
                {
                    "id": 10,
                    "type": "PrimitiveStringMultiline",
                    "widgets_values": ["First multiline prompt value."],
                },
                {
                    "id": 11,
                    "type": "PrimitiveStringMultiline",
                    "widgets_values": ["Second multiline prompt value."],
                },
            ]
        }
        prompts = extract_prompts_from_workflow(workflow, mode="discover")
        self.assertEqual(
            [prompt["field_key"] for prompt in prompts],
            [
                "PrimitiveStringMultiline::10::0",
                "PrimitiveStringMultiline::11::0",
            ],
        )

    def test_custom_mode_can_include_a_selected_bypassed_field(self):
        prompts = extract_prompts_from_workflow(
            self.workflow,
            mode="custom",
            allowed_fields={"MutedText::3::0"},
            active_only=False,
        )
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0]["node_status"], "muted")
        self.assertFalse(prompts[0]["node_active"])

    def test_selected_bypassed_field_can_be_hidden_without_deselecting_it(self):
        workflow = {
            "nodes": [
                {
                    "id": 4,
                    "type": "PrimitiveStringMultiline",
                    "title": "Edit Prompt",
                    "mode": 4,
                    "widgets_values": ["Keep this selected edit prompt hidden for this image."],
                }
            ]
        }
        field_key = "PrimitiveStringMultiline::4::0"

        visible = extract_prompts_from_workflow(
            workflow,
            mode="custom",
            allowed_fields={field_key},
            active_only=False,
        )
        hidden = extract_prompts_from_workflow(
            workflow,
            mode="custom",
            allowed_fields={field_key},
            active_only=False,
            excluded_statuses={"bypassed"},
        )

        self.assertEqual([prompt["field_key"] for prompt in visible], [field_key])
        self.assertEqual(hidden, [])

    def test_model_and_file_values_are_detected(self):
        self.assertTrue(is_file_path_or_model("models/checkpoint.safetensors"))
        self.assertTrue(is_file_path_or_model("C:\\models\\model.gguf"))
        self.assertFalse(is_file_path_or_model("soft lighting over a quiet landscape"))

    def test_prompt_nodes_are_likely_prompt_fields(self):
        self.assertTrue(
            is_likely_prompt_field(
                "PrimitiveStringMultiline",
                "Positive Prompt",
                "red fox",
            )
        )
        self.assertTrue(
            is_likely_prompt_field(
                "CLIPTextEncode",
                "CLIP Text Encode",
                "A quiet landscape under pale morning light.",
            )
        )

    def test_configuration_nodes_are_not_likely_prompt_fields(self):
        technical_fields = [
            ("KSamplerSelect", "KSamplerSelect", "euler"),
            ("SaveImage", "SaveImage", "Artifact_WIP"),
            ("BasicScheduler", "BasicScheduler", "beta"),
            ("Note", "Note - Seed", "Controls the randomness of generation."),
            ("PrimitiveNode", "width", "fixed"),
            (
                "TASmartLLM",
                "LLM processing",
                "You are an image editing prompt specialist.",
            ),
        ]
        for node_type, title, value in technical_fields:
            with self.subTest(node_type=node_type, title=title):
                self.assertFalse(
                    is_likely_prompt_field(node_type, title, value)
                )

    def test_unknown_natural_language_field_is_kept(self):
        self.assertTrue(
            is_likely_prompt_field(
                "CustomNode",
                "Custom Node",
                "Soft window light falls across an otherwise empty room.",
            )
        )
        self.assertFalse(
            is_likely_prompt_field("CustomNode", "Custom Node", "enabled")
        )


if __name__ == "__main__":
    unittest.main()
