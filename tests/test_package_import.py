import importlib.util
import sys
import types
import unittest
from pathlib import Path


class FakeRoutes:
    def __init__(self):
        self.paths = []

    def get(self, path):
        self.paths.append(path)

        def decorator(function):
            return function

        return decorator


class PackageImportTests(unittest.TestCase):
    def test_package_registers_prompt_viewer_routes(self):
        package_root = Path(__file__).resolve().parents[1]
        routes = FakeRoutes()
        stubs = {
            "aiohttp": types.SimpleNamespace(
                web=types.SimpleNamespace(json_response=lambda *args, **kwargs: None)
            ),
            "PIL": types.SimpleNamespace(Image=types.SimpleNamespace()),
            "folder_paths": types.SimpleNamespace(
                get_output_directory=lambda: "/tmp/output"
            ),
            "server": types.SimpleNamespace(
                PromptServer=types.SimpleNamespace(
                    instance=types.SimpleNamespace(routes=routes)
                )
            ),
        }

        previous = {name: sys.modules.get(name) for name in stubs}
        sys.modules.update(stubs)
        try:
            spec = importlib.util.spec_from_file_location(
                "comfyui_prompt_viewer",
                package_root / "__init__.py",
                submodule_search_locations=[str(package_root)],
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)

            self.assertEqual(module.NODE_CLASS_MAPPINGS, {})
            self.assertEqual(module.WEB_DIRECTORY, "./web")
            self.assertEqual(
                set(routes.paths),
                {
                    "/history_tools/prompt_viewer/images",
                    "/history_tools/prompt_viewer/prompts",
                    "/history_tools/prompt_viewer/search",
                    "/history_tools/prompt_viewer/discover_fields",
                    "/history_tools/prompt_viewer/subfolders",
                },
            )
        finally:
            for name, module in previous.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
            for name in list(sys.modules):
                if name == "comfyui_prompt_viewer" or name.startswith(
                    "comfyui_prompt_viewer."
                ):
                    sys.modules.pop(name, None)


if __name__ == "__main__":
    unittest.main()
